# Authoring symulacji od zera w Control Room — audyt i projekt wariantu B

**Data:** 2026-08-23

**Status:** projekt zaakceptowany kierunkowo przez wybór wariantu B

**Zakres kontraktu:** aktywny `SceneDocument` i `ProblemIR 0.3`; bez migracji do `ProblemIR 0.4`

## 1. Cel

Control Room ma umożliwiać utworzenie kompletnej, wykonywalnej symulacji bez
wcześniej uruchomionego skryptu Python:

1. utworzenie pustej sesji FDM albo FEM,
2. dodanie ferromagnetyka z obsługiwanej geometrii,
3. edycję położenia obiektu,
4. utworzenie lub przypisanie materiału,
5. przypisanie początkowej tekstury magnetycznej,
6. skonfigurowanie obsługiwanych oddziaływań,
7. skonfigurowanie i zbudowanie dyskretyzacji,
8. utworzenie etapu badania,
9. uruchomienie symulacji,
10. eksport kanonicznego skryptu Python zgodnego z `ProblemIR 0.3`.

Efektem nie ma być osobny „model UI”. Wszystkie mutacje przechodzą przez
resource-first API v2, zachowują rewizje i aktualizują tę samą projekcję
`SceneDocument`, z której powstaje skrypt oraz aktywny `ProblemIR 0.3`.

## 2. Świadoma decyzja architektoniczna

Wybrano wariant B: implementacja pełnego workflow na aktywnym kontrakcie 0.3.

Konsekwencje:

- nie aktywujemy `ProblemIRV04`;
- nie przenosimy produkcyjnego modelu na `objects`, `material_assignments`,
  `interfaces` i `magnetization_modules` z 0.4;
- zachowujemy obecny most `SceneDocument -> ScriptBuilder -> Python -> ProblemIR 0.3`;
- test round-trip potwierdza semantykę 0.3, nie równoważność z 0.4;
- dług migracyjny 0.4 pozostaje jawny i poza zakresem tego wdrożenia.

Transformacje mają następującą granicę:

- translacja jest wspierana end-to-end dla produkcyjnych geometrii FDM i FEM;
- viewport otrzymuje działający tryb Move;
- `SceneDocument` nadal przechowuje quaternion i skalę do wizualizacji;
- Rotate i Scale pozostają niedostępne w authoringu wykonawczym, dopóki
  publiczna geometria 0.3 i owner-frame lowering nie potrafią zachować ich bez
  utraty semantyki;
- niedostępność ma być widoczna wraz z konkretnym powodem, a nie ukryta lub
  zakończona późnym błędem adaptera.

## 3. Metoda audytu

Audyt objął:

- shell, menu aplikacji, ribbon, Explorer, Inspector i viewport 3D;
- typed API facade, resource hooks, komendy i generowany OpenAPI v2;
- `SceneDocument`, adapter do `ScriptBuilder`, Python DSL oraz aktywny
  `ProblemIR 0.3`;
- capability matrix i różnice FDM/FEM;
- testy jednostkowe, API, smoke oraz brakujące testy przeglądarkowe;
- rzeczywiste uruchomienie `/workspace` bez backendu i aktywnej sesji.

Baseline w osobnym worktree:

- 7 plików testowych authoringu;
- 235 testów zaliczonych;
- testy potwierdzają działanie modeli pomocniczych i komend, ale nie pełny
  workflow użytkownika.

## 4. Stan istniejący

### 4.1 Punkt wejścia i sesja

Istnieje techniczny endpoint tworzenia sesji, ale produkt nie udostępnia go jako
procedury authoringu.

- `workspace.new-problem` jest placeholderem ukrytym lub wyłączonym w
  `apps/control-room/src/kernel/layout/appMenuModel.tsx` i
  `apps/control-room/src/kernel/commands/shellCommands.ts`;
- wybór FDM/FEM w shellu również jest placeholderem;
- `WorkspaceShellClient` uruchamia zasłonę `SimulationStartupOverlay` przed
  wejściem do workspace;
- bez kompatybilnej aktywnej sesji użytkownik widzi komunikat o niedostępnym
  statusie przygotowania, a nie możliwość utworzenia problemu.

Weryfikacja przeglądarkowa potwierdziła pełnoekranowy stan
„Preparation status unavailable” i brak dostępnej ścieżki `New Problem`.

### 4.2 Geometria

Istnieją:

- komendy tworzenia draftów i zapisu geometrii;
- Inspector dla parametrów geometrii;
- endpointy create/patch/delete;
- obsługa `base_revision`;
- renderowanie zatwierdzonych obiektów w viewportcie;
- wybór obiektu przez kliknięcie.

Produkcyjnie wystawione są przede wszystkim Box i Cylinder. Sphere ma
rozbieżność między ekspozycją UI a capability/runtime. Pozostałe primitive są
ukryte lub wyłączone.

Braki:

- draft nie jest renderowany przed zapisem;
- ribbon i Inspector nie tworzą jednej czytelnej procedury;
- część geometrii jest eksponowana mimo braku pełnej lane wykonawczej;
- nie ma browser E2E dodania i późniejszej edycji obiektu;
- brak kompletnej obsługi odrzucenia i konfliktu rewizji;
- komunikaty nie tłumaczą wpływu zmiany geometrii na mesh.

### 4.3 Transformacje

Istnieją:

- pola translacji, obrotu i skali w Inspectorze;
- `Transform3D` z `translation`, `rotation_quat`, `scale`, `pivot`;
- poprawne liczenie world bounds dla obróconego i skalowanego obiektu;
- wizualne gizma viewportu.

Braki i niespójności:

- ribbon Move/Rotate/Scale jest wyłączony;
- gizma nie obsługują drag;
- UI używa miejscami reprezentacji obrotu niezgodnej z serwerowym
  `rotation_quat`;
- adapter `SceneDocument -> ScriptBuilder` jawnie odrzuca obrót i skalę;
- translacja działa tylko przez pola numeryczne i nie ma pełnego testu
  viewport -> zapis -> reload;
- aktualizacja transformacji nie ma potwierdzonego browser E2E dla invalidacji
  mesha.

### 4.4 Materiały

Istnieją:

- Material Library;
- tworzenie, modyfikacja i usuwanie materiałów;
- przypisanie materiału do obiektu;
- edycja `Ms`, `A`, parametrów DMI i anizotropii w obsługiwanym zakresie;
- resource-first API i testy modeli pomocniczych.

Braki:

- użytkownik musi przechodzić między Material Library i Inspectorem obiektu;
- nie ma ścieżki „utwórz i przypisz” w kontekście nowego obiektu;
- nie ma browser E2E potwierdzającego zapis, ACK, refetch i stabilność panelu;
- UI nie prowadzi użytkownika przez brakujące obowiązkowe parametry.

### 4.5 Magnetyzacja początkowa

Istnieją:

- Inspector tekstur;
- katalog presetów i parametrów;
- transformacja tekstury;
- zapis assetu i przypisanie do obiektu;
- testy modeli oraz części adapterów.

Braki:

- brak pełnego testu przeglądarkowego;
- kod toleruje niektóre niepowodzenia synchronizacji skryptu, co może zostawić
  niespójną projekcję;
- brak jednolitego stanu draft/preview/apply/cancel;
- brak checklisty wskazującej, że obiekt nie ma inicjalizacji.

### 4.6 Oddziaływania

Istnieją panele i capability gating dla części modułów, między innymi Exchange,
Demag, Zeeman i wybranych anizotropii.

Braki:

- kilka modułów pozostaje `planner_deferred`;
- dostępność FEM/FDM nie jest prezentowana jako jedna macierz gotowości;
- brak browser E2E dodania, parametryzacji, usunięcia i ponownego wczytania;
- brak jednoznacznego wpływu mutacji na stan mesha i wyników;
- UI może sprawiać wrażenie kompletnego mimo niewykonywalnego stosu fizyki.

### 4.7 Dyskretyzacja FDM

To największa luka funkcjonalna wariantu FDM.

Istnieje projekcja plan-owned structured grid, ale panel jest zasadniczo tylko
do odczytu. `mesh.build-selected` nie jest oferowane dla FDM.

Brakuje authoringu:

- domeny i extentu;
- rozmiaru komórki lub liczby komórek;
- periodyczności;
- estymacji liczby komórek i pamięci;
- preview siatki;
- jawnego Apply/Build;
- stanów fresh/stale/building/failed;
- browser E2E od pustego problemu do gotowej siatki.

### 4.8 Dyskretyzacja FEM

FEM ma znacznie pełniejszą obsługę:

- object mesh policy;
- shared-domain;
- airbox;
- komendy budowania i projekcję wyników.

Do domknięcia pozostają:

- spójny command-detail i provenance;
- zachowanie draftu po błędzie i konflikcie;
- stabilność Inspectora podczas ACK/refetch;
- kompletne browser E2E tworzenia obiektu i mesha od pustej sesji;
- symetryczna z FDM prezentacja gotowości modelu.

### 4.9 Study i Run

Istnieje authoring podstawowych etapów oraz uruchomienie gotowego modelu.

Braki:

- brak procedury prowadzącej od pustego study;
- część komend stage jest wyłączona;
- zapis całej tablicy `study.stages` może mieć ryzyko konfliktu równoległych
  mutacji;
- Run nie pokazuje kompletnej listy warunków gotowości;
- brak end-to-end dla modelu stworzonego wyłącznie przez UI.

### 4.10 Testy i jakość

Nie istnieje test akceptacyjny:

`empty session -> object -> transform -> material -> texture -> interactions -> mesh -> stage -> run`.

Obecny smoke geometrii startuje z gotowego skryptu FDM, dodaje Box do działającej
sceny i sprawdza jedynie wąski fragment pól oraz zatwierdzenie. Nie pokrywa:

- pustej sesji;
- wyboru lane;
- edycji zatwierdzonego obiektu;
- materiału;
- tekstury;
- oddziaływań;
- siatki FDM i FEM;
- uruchomienia;
- konfliktów;
- eksportu i ponownego wczytania.

## 5. Przyczyny źródłowe

1. **Runtime-first startup.** Shell zakłada, że sesja i solver już istnieją.
2. **Rozproszone fragmenty authoringu.** Komendy, Inspector, biblioteki i mesh nie
   tworzą jednej procedury.
3. **Brak stanu draft jako zasobu produktu.** Drafty są lokalne i nie są
   konsekwentnie renderowane ani odzyskiwane po konflikcie.
4. **Asymetria FDM/FEM.** FEM ma mesh authoring, FDM eksponuje głównie gotowy plan.
5. **Capability drift.** Ribbon, dokumentacja, adapter i runtime nie zawsze
   wystawiają ten sam zakres geometrii i fizyki.
6. **Brak akceptacyjnego E2E.** Testy jednostkowe nie wykrywają przerw między
   poprawnymi lokalnie komponentami.
7. **Przejściowy model 0.3.** `SceneDocument` przechowuje więcej informacji niż
   potrafi bezstratnie obniżyć aktywna ścieżka wykonawcza.

## 6. Docelowy workflow użytkownika

### 6.1 Utworzenie problemu

`File -> New Problem` otwiera modal z:

- nazwą;
- backendem FDM/FEM;
- urządzeniem i precyzją wynikającymi z capabilities;
- jednostkami prezentacyjnymi;
- przyciskiem Create.

Create wywołuje typed command/API, tworzy pustą sesję i dopiero po sukcesie
przełącza workspace na nową tożsamość sesji. Błąd zachowuje modal i dane.

Brak sesji nie uruchamia już zasłony przygotowania solvera. Pokazuje pusty stan
authoringu z CTA `New Problem` i `Open Problem`.

### 6.2 Checklista modelu

Workspace pokazuje jedną pochodną checklistę:

- geometry;
- material;
- initial magnetization;
- interactions;
- discretization;
- study;
- execution capability.

Checklista nie duplikuje stanu. Powstaje z zasobów sesji i capability matrix.

### 6.3 Dodanie obiektu

1. Użytkownik wybiera produkcyjnie obsługiwany primitive.
2. UI tworzy lokalny draft z nowym stabilnym `object_id`.
3. Draft jest widoczny w viewportcie w odróżnialnym stylu.
4. Inspector pozwala zmienić nazwę, parametry i translację.
5. Apply zapisuje obiekt z `base_revision`.
6. ACK podmienia draft projekcją serwerową bez remountu panelu.
7. Cancel usuwa wyłącznie lokalny draft.

### 6.4 Materiał i tekstura

Po zapisaniu obiektu checklista prowadzi kolejno do:

- wyboru materiału albo utworzenia go w kontekście obiektu;
- walidacji parametrów SI;
- przypisania assetu magnetyzacji;
- podglądu tekstury;
- atomowego zapisu zasobu i przypisania.

### 6.5 Oddziaływania

Lista pochodzi z capability matrix. Każdy wpis ma stan:

- supported;
- unavailable z powodem;
- planner-deferred;
- active.

UI nie aktywuje fizyki na podstawie nazwy ani typu obiektu.

### 6.6 Dyskretyzacja

FDM udostępnia edytowalny structured-grid policy. FEM używa obecnych object/shared
mesh policies. Oba warianty pokazują wspólne stany świeżości i komend.

### 6.7 Study i Run

Po utworzeniu co najmniej jednego etapu Run staje się aktywne tylko wtedy, gdy
checklista nie zawiera blokujących problemów. Nieaktywny Run pokazuje pełną listę
braków.

## 7. Kontrakty implementacyjne

### 7.1 API i zasoby

- wszystkie komponenty używają centralnego typed clienta;
- nie dodajemy bezpośredniego `fetch` w modułach;
- mutacje zwracają command acknowledgement i oczekiwaną rewizję;
- realtime jedynie unieważnia zasoby; nie przenosi alternatywnego modelu;
- ciężkie mesh/field payloady pozostają w data plane;
- generowany OpenAPI jest aktualizowany razem z serwerem i klientem;
- brak sesji jest prawidłowym stanem domenowym, nie błędem kompatybilności API.

### 7.2 Stan klienta

- stan serwerowy pozostaje w resource hooks/cache;
- Zustand przechowuje wyłącznie stan workspace i lokalne drafty;
- draft ma tożsamość celu, `base_revision`, dirty fields i pending field set;
- jedna mutacja nie może wyłączać całego Inspectora;
- ACK/refetch nie może resetować fokusu, scrolla ani niespokrewnionych draftów;
- jeden owner odpowiada za subskrypcję danego zasobu w drzewie panelu.

### 7.3 Konflikty i błędy

- walidacja lokalna blokuje wysłanie niepoprawnych wartości;
- błąd serwera zostaje przypięty do komendy lub pola;
- `409` zachowuje draft i oferuje refetch/rebase;
- command failure nie podmienia ostatniej dobrej projekcji;
- niedostępna capability ma stabilny reason code i opis;
- zerwanie realtime nie usuwa danych ani nie remountuje workspace.

### 7.4 Unieważnianie dyskretyzacji

Zmiany geometrii, translacji, domeny i parametrów siatki oznaczają mesh `stale`.

Zmiany materiału, tekstury i parametrów oddziaływań nie przebudowują topologii,
chyba że konkretny backend jawnie zgłosi inną zależność. Zmiana początkowej
magnetyzacji unieważnia stan początkowy i wyniki, nie mesh topology.

## 8. Macierz minimalnego zakresu produkcyjnego

| Funkcja | FDM | FEM |
|---|---:|---:|
| Nowa pusta sesja | wymagane | wymagane |
| Box | wymagane | wymagane |
| Cylinder | wymagane po potwierdzeniu capability | wymagane po potwierdzeniu capability |
| Sphere | tylko po wyrównaniu capability/runtime | tylko po wyrównaniu capability/runtime |
| Draft preview | wymagane | wymagane |
| Translacja numeryczna | wymagane | wymagane |
| Drag Move | wymagane | wymagane |
| Rotate/Scale wykonawcze | poza zakresem 0.3 | poza zakresem 0.3 |
| Materiał create/assign/edit | wymagane | wymagane |
| Tekstura uniform + obsługiwane presety | wymagane | wymagane |
| Obsługiwane interactions | wymagane | wymagane |
| Structured-grid authoring | wymagane | nie dotyczy |
| Object/shared mesh policy | nie dotyczy | wymagane |
| Stage relax | wymagane | wymagane |
| Run | wymagane | wymagane |
| Python/ProblemIR 0.3 round-trip | wymagane | wymagane |

## 9. Wymagane testy akceptacyjne

### E1 — FDM od zera

Nowa sesja FDM CPU double, Box, translacja przez Inspector i drag, nowy materiał,
uniform texture, Exchange + Demag, edycja structured grid, build/apply, stage
relax, Run i poprawna projekcja wyników.

### E2 — FEM od zera

Nowa sesja FEM CPU, Box, translacja, materiał, tekstura, interakcje, object/shared
mesh z airbox tam, gdzie wymagany, build, relax i Run.

### E3 — invalidacja i stabilność

- materiał nie przebudowuje mesha;
- tekstura nie zmienia mesh revision;
- geometria i translacja oznaczają mesh stale;
- pending jednego pola nie wyłącza pozostałych;
- scroll, focus i root identity Inspectora pozostają stabilne;
- ACK i realtime powodują ograniczoną liczbę requestów/renderów.

### E4 — round-trip 0.3

UI -> `SceneDocument` -> canonical Python -> reload -> normalized
`ProblemIR 0.3`. Porównanie obejmuje geometrię, translację, materiał,
magnetyzację, interactions, discretization, study i execution intent.

### E5 — przypadki negatywne

- błędne wymiary geometrii nie opuszczają draftu;
- `409` zachowuje wartości użytkownika;
- niewspierany primitive ma wyjaśnienie;
- Rotate/Scale mają capability reason, a nie późny wyjątek;
- Run wskazuje brakujące wymagania;
- canvas jest widoczny, WebGL context nie jest utracony, drawing buffer jest
  niezerowy.

## 10. Kryteria ukończenia

Praca jest ukończona dopiero, gdy:

1. użytkownik może przejść E1 i E2 bez skryptu startowego;
2. nie istnieje blokująca zasłona dla prawidłowego stanu „brak sesji”;
3. wszystkie mutacje przechodzą przez typed resource-first API;
4. capability exposure zgadza się z plannerem i runtime;
5. FDM ma edytowalną dyskretyzację;
6. FEM zachowuje istniejące kontrakty object/shared mesh i provenance;
7. Move działa numerycznie oraz przez viewport;
8. round-trip 0.3 przechodzi dla FDM i FEM;
9. E1–E5 oraz odpowiednie testy jednostkowe, API, typecheck i lint przechodzą;
10. viewport przechodzi obowiązkowy smoke WebGL;
11. native FEM przechodzi właściwe zarządzane receptury `just`;
12. dokumentacja jasno zapisuje, że Rotate/Scale i migracja 0.4 pozostają poza
    zakresem aktywnego kontraktu.

## 11. Ryzyka

- tworzenie sesji może wymagać rozdzielenia authoringu od inicjalizacji solvera;
- obecne endpointy mogą nie zapewniać atomowego utworzenia assetu magnetyzacji i
  przypisania;
- FDM structured-grid authoring może wymagać nowego zasobu API;
- istniejące stage mutations mogą wymagać rewizyjnego modelu operacji zamiast
  podmiany całej tablicy;
- capability drift może wymusić korekty OpenAPI, planera i UI równocześnie;
- pełny browser E2E może ujawnić problemy lifecycle viewportu niewidoczne w
  testach jednostkowych.

Każde ryzyko zostanie najpierw odtworzone testem. Nie będzie obchodzone przez
lokalne wyjątki, ciche fallbacki ani alternatywny stan UI.
