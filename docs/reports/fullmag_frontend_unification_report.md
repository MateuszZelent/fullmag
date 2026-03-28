# Fullmag — raport ujednolicenia frontendu

## 1. Streszczenie wykonawcze

Frontend `fullmag` nie wymaga dziś pełnego przepisywania od zera, ale wymaga świadomej unifikacji architektury UI. Największy problem nie polega na pojedynczym złym komponencie, tylko na tym, że współistnieją trzy różne warstwy stylistyczno-architektoniczne:

1. shell typu desktop/IDE dla control roomu,
2. starszy system stron aplikacyjnych oparty o globalne klasy i inline style,
3. lokalne, jednorazowe mikro-UI budowane bez wspólnego kontraktu.

To daje efekt, który słusznie wyczułeś: każdy element trochę żyje własnym życiem, a kolejne funkcje lądują tam, gdzie akurat było miejsce, a nie tam, gdzie powinny wylądować w spójnym produkcie.

Moja rekomendacja:

1. nie robić pełnego rewrite całego frontendu od zera,
2. zrobić kontrolowaną przebudowę wokół wspólnego systemu shell + design system + zasad wdrożeniowych,
3. potraktować `RunControlRoom` jako wzorzec docelowego profesjonalnego interfejsu,
4. wyczyścić duplikacje komend i rozjazdy tokenów zanim dołożymy więcej funkcji.

Najważniejsza decyzja produktowa:

- `TitleBar` nie powinien być miejscem dla głównych akcji solvera.
- Główne akcje `Relax`, `Run`, `Pause`, `Stop` powinny mieszkać w `RibbonBar`.
- `TitleBar` powinien zostać zredukowany do roli kontekstowo-statusowej: nazwa problemu, backend, runtime, status połączenia, marka.

## 1.1. Metodologia audytu

Raport powstał na podstawie:

- przeglądu shellu `RunControlRoom`,
- przeglądu komponentów `TitleBar`, `MenuBar`, `RibbonBar`, `StatusBar`, `RunSidebar`, `SettingsPanel`,
- przeglądu `globals.css`, `shell.module.css`, `Button.tsx`, `Button.module.css`,
- szybkiego skanu długu repo (`style={{ ... }}`, `@ts-nocheck`, ręczne implementacje `<button>`),
- zasad z aktualnych Vercel Web Interface Guidelines,
- zasad z Vercel React Best Practices dla komponentów React/Next.

To nie jest raport „estetyczny”, tylko raport architektury UI i utrzymywalności produktu.

## 2. Najważniejsze problemy stanu obecnego

### 2.1. Zdublowane powierzchnie komend

W tej chwili akcje solvera są wystawione równolegle w kilku miejscach:

- `apps/web/components/shell/TitleBar.tsx`
- `apps/web/components/shell/RibbonBar.tsx`
- `apps/web/components/shell/MenuBar.tsx`

To jest błąd informacyjny i błąd hierarchii interfejsu:

- użytkownik nie wie, która powierzchnia jest główna,
- shell staje się „przegadany”,
- kolejne akcje trafiają tam, gdzie akurat jest szybciej je dopisać,
- rośnie koszt utrzymania stanów `enabled/disabled`, tooltipów i skrótów.

Rekomendacja:

- `RibbonBar` = główna powierzchnia akcji.
- `MenuBar` = alternatywna powierzchnia desktopowa i skróty.
- `TitleBar` = tylko status i kontekst, bez głównych CTA.
- `StatusBar` = pasywna telemetria.

## 2.2. Równoległe systemy tokenów i nazewnictwa

W `apps/web/app/globals.css` współistnieją równolegle co najmniej te rodziny tokenów:

- `--ide-*`
- `--am-*`
- `--text-*`
- `--surface-*`
- `--accent-*`
- `--glass-*`
- `--status-*`
- `--energy-*`

Sam fakt posiadania kilku rodzin nie musi być błędem, ale tutaj nie tworzą one świadomej hierarchii. Część jest semantyczna, część historyczna, część wizualna, a część wygląda jak pozostałość po wcześniejszych etapach projektu.

Co gorsza, w `globals.css` są używane tokeny, których nie znalazłem zdefiniowanych w `apps/web`, m.in.:

- `--bg-root`
- `--text-primary`
- `--text-secondary`
- `--glass-bg`
- `--glass-blur`
- `--glass-border`
- `--border-subtle`
- `--scrollbar-track`
- `--scrollbar-thumb`
- `--accent-subtle`

To oznacza, że część systemu wizualnego działa dziś przypadkiem albo przez fallbacki, a nie przez stabilny kontrakt.

Rekomendacja:

- ustanowić jeden oficjalny system tokenów semantycznych dla całej aplikacji,
- oznaczyć stare tokeny jako legacy i migrować warstwami,
- zablokować dodawanie nowych rodzin tokenów bez jawnej decyzji architektonicznej.

## 2.3. Za dużo inline stylów

Szybki audyt repo pokazuje obecnie około `180` wystąpień `style={{ ... }}` w `apps/web`.

Najwięcej długu widać na stronach:

- `apps/web/app/(main)/simulations/page.tsx`
- `apps/web/app/(main)/settings/page.tsx`
- `apps/web/app/(main)/visualizations/page.tsx`
- `apps/web/app/(main)/docs/physics/page.tsx`

oraz w pojedynczych panelach i viewerach.

To ma kilka skutków:

- trudniej utrzymać spójność spacingu, typografii i stanów,
- komponenty nie mają czytelnego API wizualnego,
- trudniej prowadzić refaktoryzację lub theme-owanie,
- styl przestaje być częścią design systemu i wraca do poziomu „lokalnych wyjątków”.

Rekomendacja:

- zakazać nowych inline stylów poza ściśle dynamicznymi przypadkami,
- dopuszczać inline wyłącznie dla wartości runtime, których nie da się sensownie opisać klasą lub CSS variable,
- przenieść layout i wygląd do CSS modules albo wspólnych prymitywów.

## 2.4. Zbyt wiele jednorazowych implementacji przycisków i toolbarów

Mamy dziś wspólny `Button`, ale równolegle bardzo dużo ręcznie stylowanych `<button>`:

- `TitleBar`
- `RibbonBar`
- `MenuBar`
- widoki 3D
- `ModelTree`
- `EngineConsole`
- `FemWorkspacePanel`
- panele ustawień

To oznacza, że zamiast jednego systemu interakcji mamy wiele lokalnych interpretacji:

- różne wysokości,
- różne promienie,
- różne hover/focus,
- różne disabled states,
- różne sposoby oznaczania aktywności.

Rekomendacja:

- zbudować rodzinę prymitywów:
  - `Button`
  - `IconButton`
  - `CommandButton`
  - `ToggleButton`
  - `ToolbarButton`
- a następnie przepiąć shell i widoki na te komponenty.

## 2.5. Niespójna semantyka shellu

Shell produktu jest już blisko dobrego kierunku, ale obecnie miesza role:

- `TitleBar` robi trochę branding, trochę status, trochę toolbar,
- `MenuBar` robi klasyczne menu desktopowe,
- `RibbonBar` robi toolbar produktowy,
- `StatusBar` robi telemetrię i stan procesu.

To jest zbyt wiele nakładających się odpowiedzialności.

Docelowa semantyka powinna być jednoznaczna:

- `TitleBar`: kontekst sesji + identyfikacja.
- `MenuBar`: systemowe i eksperckie operacje.
- `RibbonBar`: główne akcje domenowe.
- `ViewportBar`: sterowanie aktywnym widokiem i prezentacją danych.
- `Sidebar`: nawigacja modelu + inspector.
- `Console`: logi, diagnostyka, tabela, wykresy.
- `StatusBar`: pasywna informacja o przebiegu i zasobach.

## 2.6. Dług techniczny typów i viewerów

W `apps/web` nadal są `@ts-nocheck` w kilku miejscach. Szybki skan pokazuje `4` takie wystąpienia.

To nie musi oznaczać awarii, ale oznacza brak domknięcia kontraktu UI. W produkcie, który ma wyglądać profesjonalnie, viewer 3D, shell i warstwa sterowania nie powinny być utrzymywane przez strefy „bez kontroli typów”.

Rekomendacja:

- potraktować usunięcie `@ts-nocheck` jako część unifikacji frontendu,
- nie dopuszczać nowych wyjątków bez bardzo mocnego uzasadnienia.

## 3. Docelowy model architektury UI

Proponuję 5-warstwowy model frontendu.

### 3.1. Warstwa 1 — design tokens

Jedno źródło prawdy dla:

- kolorów semantycznych,
- powierzchni,
- obramowań,
- typografii,
- spacingu,
- radiusów,
- cieni,
- motion,
- z-indexów,
- statusów,
- kolorów domenowych fizyki.

Docelowe nazewnictwo powinno być semantyczne, nie historyczne. Przykład:

- `--color-bg-app`
- `--color-surface-1`
- `--color-surface-2`
- `--color-border-muted`
- `--color-text-primary`
- `--color-text-secondary`
- `--color-accent-primary`
- `--color-success`
- `--color-warning`
- `--color-danger`
- `--color-energy-exchange`

Zasada:

- komponent nigdy nie powinien znać surowego `hsl(...)`, jeśli istnieje odpowiedni token.

### 3.2. Warstwa 2 — prymitywy UI

To powinien być mały, stabilny zestaw komponentów:

- `Button`
- `IconButton`
- `ToolbarButton`
- `ToggleGroup`
- `Section`
- `PanelHeader`
- `Badge`
- `Field`
- `MetricField`
- `SplitPanelHandle`
- `Toolbar`
- `Dropdown`
- `Tabs`
- `EmptyState`

Każdy nowy feature ma budować z tych klocków, a nie od zera.

### 3.3. Warstwa 3 — shell produktu

Shell musi mieć jasne zasady odpowiedzialności:

- `TitleBar`
- `MenuBar`
- `RibbonBar`
- `StatusBar`
- `RunSidebar`
- `ViewportBar`
- `EngineConsole`

Na tym poziomie nie dokładamy lokalnych eksperymentalnych styli. Shell powinien mieć własne kontrakty:

- wysokości,
- grid,
- separatory,
- typy grup,
- układ ikon i etykiet,
- rytm pionowy.

### 3.4. Warstwa 4 — feature panels

To są panele typu:

- solver,
- mesh,
- results,
- material,
- geometry,
- energy,
- telemetry.

Każdy taki panel korzysta z prymitywów i nie tworzy nowego mini-design-systemu lokalnie.

### 3.5. Warstwa 5 — viewers i overlaye eksperckie

Viewery 2D/3D są specjalne, ale nie mogą być wizualnie osobnym światem. Ich overlaye powinny korzystać z tych samych:

- ikon,
- statusów,
- przycisków narzędziowych,
- popoverów,
- etykiet,
- liczników,
- paneli kontekstowych.

## 4. Zasady docelowe dla shellu

### 4.1. `TitleBar`

Powinien zawierać tylko:

- nazwę aktywnej symulacji,
- backend / runtime,
- status połączenia,
- stan sesji,
- branding.

Nie powinien zawierać:

- głównych przycisków solvera,
- lokalnych toolbarów,
- gęstych akcji feature’owych.

### 4.2. `MenuBar`

Powinien zawierać:

- klasyczne operacje desktopowe,
- alternatywne wejście do komend,
- skróty klawiszowe,
- operacje eksperckie i systemowe.

### 4.3. `RibbonBar`

Powinien być jedynym głównym miejscem dla akcji domenowych:

- `Relax`
- `Run`
- `Pause`
- `Stop`
- `Setup`
- `Export`
- przełączniki widoku
- operacje na wynikach

To jest najważniejsza decyzja do wdrożenia natychmiast.

### 4.4. `StatusBar`

Powinien pokazywać:

- connection,
- aktywność,
- postęp,
- step/time,
- throughput,
- backend/precision,
- ewentualnie obciążenie viewerów.

Bez głównych CTA.

## 5. Wspólny styl wizualny

### 5.1. Typografia

Zasady:

- shell używa zwartej, czytelnej typografii technicznej,
- liczby i telemetria: mono,
- etykiety sekcji: uppercase tylko tam, gdzie faktycznie budują hierarchię,
- nie mieszać kilku różnych rytmów literowania i `letter-spacing`.

### 5.2. Kolor

Kolorystyka ma być semantyczna:

- neutralne powierzchnie,
- jeden główny akcent interakcyjny,
- osobne kolory statusów,
- osobne kolory domenowe dla energii i pól.

Zasady:

- nie używać losowych gradientów lub kolorów lokalnie,
- nie kodować statusu raz niebieskim, raz zielonym, jeśli to ten sam stan,
- nie mieszać „accent systemowego” z „kolorem domeny” bez powodu.

### 5.3. Ikony

Trzeba ustalić słownik ikon i nie zmieniać go lokalnie:

- solver actions,
- mesh actions,
- capture/export,
- warnings/status,
- 2D/3D/view toggles.

### 5.4. Gęstość interfejsu

Fullmag jest narzędziem eksperckim, więc może być gęsty, ale musi być przewidywalny. To oznacza:

- stałe wysokości pasów shellu,
- stałe wysokości toolbarów,
- stałe spacingi w sekcjach,
- stałe rozmiary nagłówków,
- stałe rozmiary buttonów per kontekst.

## 6. Zasady kodowe i wdrożeniowe

### 6.1. Twarde zasady

Od teraz proponuję przyjąć:

1. Żaden nowy główny przycisk produktu nie trafia do `TitleBar`.
2. Żadna nowa akcja domenowa nie powstaje jako ręcznie stylowany `<button>`, jeśli istnieje odpowiedni prymityw.
3. Żaden nowy kolor nie jest wpisywany jako `hsl(...)` lub hex w komponencie, jeśli da się go wyrazić tokenem.
4. Żaden nowy panel nie buduje własnego lokalnego systemu sekcji, badge’y i nagłówków.
5. Inline style dopuszczamy tylko dla wartości dynamicznych runtime.
6. Każdy icon-only button musi mieć `aria-label`.
7. Każdy focus state musi być jawny i widoczny.
8. Każdy nowy element shellu musi być przypisany do jednej warstwy odpowiedzialności.

### 6.2. Reguły dla React i modułów CSS

Zalecam:

- logikę interakcyjną trzymać w komponentach,
- wygląd trzymać w CSS modules albo w prymitywach UI,
- unikać definiowania lokalnych „mini komponentów stylu” przez przypadek,
- usuwać `style={{ ... }}` z layoutów stron i paneli,
- hoistować powtarzalne JSX i stany tam, gdzie naprawdę są wspólne.

## 7. Plan wdrożenia

### Etap 1 — normalizacja shellu

Cel:

- ustawić jednoznaczną hierarchię `TitleBar` / `MenuBar` / `RibbonBar` / `StatusBar`.

Zakres:

- przenieść `Relax`, `Run`, `Pause`, `Stop` z `TitleBar` do `RibbonBar`,
- odchudzić `TitleBar`,
- ujednolicić grupy w `RibbonBar`,
- sprawić, żeby `MenuBar` i `RibbonBar` korzystały z jednego modelu komend.

To powinien być pierwszy PR.

### Etap 2 — extraction design system

Cel:

- wydzielić warstwę wspólnych prymitywów.

Zakres:

- `ToolbarButton`
- `CommandButton`
- `Section`
- `PanelHeader`
- `Field`
- `StatusBadge`
- `MetricSparkline`

To powinien być drugi PR.

### Etap 3 — sanacja tokenów

Cel:

- zamknąć chaos tokenów i usunąć referencje do niezdefiniowanych zmiennych.

Zakres:

- zdefiniować nowy oficjalny zestaw semantyczny,
- wprowadzić mapę migracji legacy -> canonical,
- usunąć lub zastąpić tokeny niezdefiniowane,
- zredukować surowe kolory w komponentach.

To powinien być trzeci PR.

### Etap 4 — migracja paneli i stron

Cel:

- doprowadzić strony aplikacji i panele do jednego języka wizualnego.

Zakres:

- `simulations`
- `settings`
- `visualizations`
- `docs/physics`
- wybrane panele mesh/results

Najpierw layout i typografia, potem mikrodetale.

### Etap 5 — viewers i overlaye

Cel:

- ujednolicić 2D/3D overlaye, panele narzędziowe, tooltipy i przyciski.

Zakres:

- `FemMeshView3D`
- `MagnetizationView3D`
- `ViewCube`
- overlaye kamery, eksportu, focusu, screenshotu.

### Etap 6 — domknięcie jakości

Cel:

- przejść od „działa” do „profesjonalny produkt”.

Zakres:

- usunięcie `@ts-nocheck`,
- accessibility pass,
- focus states,
- redukcja inline stylów,
- snapshoty wizualne,
- checklista review dla nowych PR.

## 8. Co robić teraz, a czego nie robić

### Róbmy teraz

1. Przenieść solver actions z `TitleBar` do `RibbonBar`.
2. Zamknąć wspólny model komend dla shellu.
3. Wydzielić zestaw prymitywów shellowych.
4. Posprzątać tokeny i undefined CSS vars.
5. Wyznaczyć frontend charter dla całego repo.

### Nie róbmy teraz

1. Pełnego rewritingu wszystkich widoków naraz.
2. Losowej wymiany kolorów bez ustalenia tokenów.
3. Dopisywania kolejnych akcji do `TitleBar`.
4. Dorabiania nowych jednorazowych buttonów i toolbarów w feature’ach.

## 9. Proponowany frontend charter

Poniższe zasady proponuję przyjąć jako obowiązujące:

1. Fullmag ma jeden język wizualny i jedną hierarchię shellu.
2. `RibbonBar` jest główną powierzchnią akcji domenowych.
3. `TitleBar` jest warstwą kontekstowo-statusową.
4. Jeden problem wizualny rozwiązujemy jednym prymitywem, nie pięcioma lokalnymi wariantami.
5. Kolory są semantyczne, nie przypadkowe.
6. Layout nie jest kodowany inline, jeśli może być częścią systemu.
7. Viewer 3D to część produktu, nie osobna aplikacja w aplikacji.
8. Każdy nowy ekran musi dać się opisać tym samym zestawem zasad.

## 10. Definition of Done dla unifikacji

Uznam tę fazę za domkniętą dopiero, gdy:

1. `TitleBar`, `MenuBar`, `RibbonBar`, `StatusBar` mają rozłączne odpowiedzialności.
2. `Relax`, `Run`, `Pause`, `Stop` żyją tylko tam, gdzie powinny.
3. Nie ma niezdefiniowanych tokenów używanych przez główne layouty.
4. Główne strony aplikacji nie polegają już na masowym inline CSS.
5. Panele i viewery używają wspólnych prymitywów interakcyjnych.
6. `@ts-nocheck` nie występuje w krytycznych częściach UI.
7. Każdy nowy frontend PR da się ocenić względem spisanych zasad.

## 11. Końcowa rekomendacja

Nie potrzebujemy dziś „spalić” frontendu i napisać go od nowa. Potrzebujemy czegoś bardziej profesjonalnego:

- wspólnego kontraktu wizualnego,
- wspólnego kontraktu komponentowego,
- wspólnego kontraktu odpowiedzialności shellu,
- i dyscypliny wdrożeniowej.

Jeśli mamy zrobić to profesjonalnie, to kolejność powinna być taka:

1. shell,
2. prymitywy,
3. tokeny,
4. panele,
5. viewery,
6. cleanup jakościowy.

To jest ścieżka, która daje profesjonalne oprogramowanie bez ryzyka chaosu, jaki zwykle przynosi pełny rewrite.
