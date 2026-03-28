# Fullmag — globalny audit frontendu pod kątem UI/UX, estetyki i spójności design systemu

**Repozytorium:** `MateuszZelent/fullmag`  
**Analizowany obszar:** `apps/web`  
**Perspektywa audytu:** globalna, systemowa, produktowa  
**Cel audytu:** nie poprawiać pojedynczego „brzydkiego” elementu, tylko wskazać, jak ujednolicić całą aplikację tak, aby kolejne zmiany nie zwiększały chaosu

---

## 1. Executive summary

Najważniejszy wniosek jest prosty:

> **Głównym problemem Fullmag nie jest pojedynczy komponent. Głównym problemem jest brak jednego, wspólnego kręgosłupa UI.**

W aktualnym stanie frontend wygląda nie jak jedna aplikacja z dwoma trybami pracy, tylko jak **kilka nakładających się systemów UI**, które powstawały równolegle:

1. **globalne klasy i layout w `app/globals.css`**,  
2. **własne CSS Modules i customowe atomy UI**,  
3. **częściowa warstwa shadcn / Radix / Tailwind**,  
4. oraz dodatkowo **raw-native controls** w części paneli.

To powoduje, że nawet jeżeli pojedynczy widok wygląda przyzwoicie, to **całość nie składa się w jeden konsekwentny produkt**. W praktyce objawia się to tak:

- `/` i reszta tras wyglądają jak dwa różne produkty,
- ikonografia nie jest spójna,
- przyciski, pola, selekty, toggles i badge’e nie mają jednego źródła prawdy,
- light mode jest obietnicą w UI, ale nie ma kompletnej warstwy tokenów,
- shadcn jest zainstalowany, lecz **nie pełni roli głównego systemu prymitywów**,
- Tailwind jest używany częściowo jako system, a częściowo jako zbiór lokalnych utility stringów.

### Werdykt strategiczny

**Najlepsza droga nie polega na „przepisaniu wszystkiego na shadcn”.**  
Najlepsza droga polega na:

- zbudowaniu **jednej warstwy tokenów**,
- zbudowaniu **jednego zestawu prymitywów** opartych o shadcn/Radix,
- i dopiero na tym utrzymaniu **dwóch legalnych shelli**:
  - **App Shell** dla zwykłych tras,
  - **Control Room Shell** dla specjalistycznego, gęstego widoku roboczego.

To jest kluczowe: **Control Room powinien zostać customowy**, bo to interfejs domenowy, ale **nie może być osobnym wszechświatem wizualnym**.

---

## 2. Ocena syntetyczna

| Obszar | Ocena orientacyjna | Komentarz |
|---|---:|---|
| Spójność systemowa | **4/10** | dziś aplikacja działa na kilku równoległych językach UI |
| Potencjał estetyczny | **8/10** | baza kolorystyczna i charakter „scientific pro-app” są mocne |
| Dojrzałość design systemu | **3/10** | infrastruktura jest, ale nie ma jednego centrum |
| Wykorzystanie shadcn/ui | **3/10** | jest obecne, lecz nie jest szkieletem aplikacji |
| UX na poziomie informacji i nawigacji | **5.5/10** | widać sensowną strukturę, ale architektura tras i shelli jest myląca |
| Czytelność i kontrast | **7/10** | dark theme jest generalnie czytelny, ale semantyka kolorów jest rozproszona |
| Gotowość do unifikacji | **8/10** | fundamenty już istnieją, problemem jest brak decyzji systemowej |

---

## 3. Zakres i metodologia

Audyt wykonałem na podstawie snapshotu frontendu w `apps/web`, w szczególności analizując:

- layout i theme:
  - `app/layout.tsx`
  - `app/(main)/layout.tsx`
  - `app/globals.css`
- shell i nawigację:
  - `components/layout/AppLayout.tsx`
  - `components/layout/Sidebar.tsx`
  - `components/layout/TopBar.tsx`
  - `components/layout/navigation.tsx`
  - `components/theme/ThemeToggle.tsx`
- trasy/strony:
  - `/settings`
  - `/simulations`
  - `/visualizations`
  - `/docs/physics`
  - `/` (Control Room)
- control room:
  - `components/runs/RunControlRoom.tsx`
  - `components/runs/RunControlRoom.module.css`
  - `components/shell/shell.module.css`
  - `components/panels/SettingsPanel.tsx`
  - `components/panels/MeshSettingsPanel.tsx`
  - `components/runs/control-room/FemWorkspacePanel.tsx`
- warstwę UI:
  - customowe atomy: `Button`, `Panel`, `SegmentedControl`, `SelectField`, `TextField`, `Toggle`
  - shadcn/Radix: `badge.tsx`, `switch.tsx`, `tabs.tsx`, `tooltip.tsx`
  - konfigurację `components.json`
  - zależności z `package.json`

### Metoda oceny

Patrzyłem na projekt w 5 osiach:

1. **spójność globalna**,  
2. **UX i architektura aplikacji**,  
3. **estetyka i semantyka kolorów**,  
4. **jakość użycia shadcn/Tailwind/Radix**,  
5. **mapa migracji do jednego stylu produktu**.

### Ważna uwaga

Ten raport **celowo nie skupia się na „naprawie jednego przycisku”**.  
Punkt odniesienia jest globalny:

> **Czy dana zmiana wzmacnia wspólny trzon aplikacji, czy tylko upiększa mały fragment kosztem jeszcze większego rozjazdu reszty?**

---

## 4. Dowody wizualne

### 4.1. Rozszczepienie shelli aplikacji

![Rozszczepienie shelli](sandbox:/mnt/data/fullmag_shell_split.png)

[Otwórz grafikę osobno](sandbox:/mnt/data/fullmag_shell_split.png)

Ta grafika pokazuje najważniejszy problem architektoniczny: **route `/` omija `AppLayout`**, a pozostałe widoki są w nim osadzone. To samo w sobie nie jest błędem — błędem jest brak wspólnego kontraktu wizualnego między tymi dwoma światami.

### 4.2. Snapshot zwykłego App Shell (`/docs/physics`)

![Snapshot Physics Docs](sandbox:/mnt/data/physics_ui_top.png)

[Otwórz grafikę osobno](sandbox:/mnt/data/physics_ui_top.png)

To jest reprezentatywny widok dla „klasycznej” części aplikacji: sidebar, page header, karty, dark glass / soft technical surface.

### 4.3. Obecna paleta i napięcie między rodzinami kolorów

![Paleta Fullmag](sandbox:/mnt/data/fullmag_palette_current_v2.png)

[Otwórz grafikę osobno](sandbox:/mnt/data/fullmag_palette_current_v2.png)

### 4.4. Fragmentacja warstwy UI

![Fragmentacja design systemu](sandbox:/mnt/data/fullmag_architecture_fragmentation_v2.png)

[Otwórz grafikę osobno](sandbox:/mnt/data/fullmag_architecture_fragmentation_v2.png)

### 4.5. Dodatkowy snapshot `/settings`

Zrzut z renderu statycznego jest miejscami obarczony artefaktami paginacji, ale nadal dobrze pokazuje charakter kart i shellu:

[Zobacz snapshot `/settings`](sandbox:/mnt/data/settings_snapshot_p2_cropped.png)

---

## 5. Najważniejsza diagnoza: problem jest systemowy, nie lokalny

### 5.1. W praktyce istnieją trzy równoległe systemy UI — plus czwarta warstwa ad hoc

#### System A — globalny CSS w `app/globals.css`

`app/globals.css` jest bardzo duży i robi naraz zbyt wiele rzeczy:

- importuje fonty,
- definiuje tokeny,
- ustawia theme,
- robi reset,
- definiuje layout,
- definiuje komponenty,
- definiuje utility klasy,
- zawiera też fragmenty bardziej „featureowe”.

To oznacza, że plik będący fundamentem aplikacji stał się jednocześnie **repozytorium design tokenów, layoutu i gotowych komponentów**.  
To jest wygodne na początku projektu, ale przy rosnącej aplikacji kończy się tym, że każdy kolejny ekran dziedziczy trochę inny język wizualny.

**Sygnał ostrzegawczy:** w samym `globals.css` znalazłem **23 custom properties używane, ale niezdefiniowane** w tym pliku. To nie jest tylko detal techniczny — to znak, że warstwa design tokenów nie jest domknięta.

Przykłady takich zmiennych:

- `--bg-root`
- `--text-primary`
- `--text-secondary`
- `--glass-bg`
- `--glass-blur`
- `--glass-border`
- `--glass-shadow`
- `--accent-hover`
- `--success`, `--warning`, `--error`, `--info`

To pokazuje, że obecny system wizualny jest częściowo „sklejony” z różnych fal zmian.

#### System B — własne CSS Modules i własne atomy UI

W kodzie są obecne własne komponenty:

- `Button.tsx`
- `Panel.tsx`
- `SegmentedControl.tsx`
- `SelectField.tsx`
- `TextField.tsx`
- `Toggle.tsx`

Każdy z nich ma własny CSS module. To samo w sobie nie jest złe. Problemem jest to, że ta warstwa **nie jest jednym konsekwentnym wrapperem wokół systemu designu**. To jest raczej równoległy mini-ecosystem.

Do tego dochodzą ogromne moduły typu:

- `RunControlRoom.module.css`
- `shell.module.css`

One są rozbudowane, mają własną gęstość interfejsu, własne rytmy spacingu i własny idiom komponentów. W praktyce tworzą **drugi świat aplikacji**.

#### System C — shadcn / Radix / Tailwind

Z `package.json` i `components.json` widać, że projekt ma już potrzebną infrastrukturę:

- Tailwind v4,
- Radix,
- `class-variance-authority`,
- `tailwind-merge`,
- `lucide-react`,
- konfigurację shadcn z `style: "new-york"` i `baseColor: "slate"`.

To jest świetna baza. Problem polega na tym, że ta baza nie jest wykorzystywana jako **domyślny zestaw prymitywów**.

W praktyce w warstwie shadcn znalazłem tylko kilka elementów:

- `badge.tsx`
- `switch.tsx`
- `tabs.tsx`
- `tooltip.tsx`

i tylko **Badge** jest używany relatywnie szeroko w zwykłych stronach.  
`Tooltip` pojawia się w RibbonBar.  
`Switch` i `Tabs` są obecne, ale w analizowanym snapshotcie nie są realnym centrum interfejsu.

#### System D — surowe kontrolki natywne w panelach

W `SettingsPanel.tsx`, `MeshSettingsPanel.tsx` i `FemWorkspacePanel.tsx` jest dużo:

- raw `<input>`
- raw `<select>`
- raw `<button>`
- raw `<input type="checkbox">`

To jest czwarta warstwa, najbardziej „operacyjna”, ale zarazem najbardziej ryzykowna dla spójności, focus states, accessibility i temingu.

### 5.2. Dlaczego to jest groźne

Przy takim układzie każda lokalna poprawka może wyglądać dobrze sama w sobie, ale szkodzić całości.  
To dokładnie ten błąd, którego chcesz uniknąć.

Przykład myślowy:

- jeśli odświeżysz tylko `SettingsPage` w czystym shadcn,
- ale zostawisz `TopBar`, `Sidebar`, `ThemeToggle`, `navigation.tsx`, control room i panele bez wspólnego kontraktu,
- to otrzymasz **jeszcze bardziej nierówną aplikację**.

Dlatego dziś najważniejsze nie jest „upiększyć widok”, tylko:

> **zamrozić rozjazd i ustalić wspólne reguły produkcyjne dla całej warstwy UI.**

---

## 6. Rozszczepienie shelli: `/` kontra reszta aplikacji

To jest druga najważniejsza diagnoza po fragmentacji systemu.

W `app/(main)/layout.tsx` istnieje warunek:

```tsx
if (pathname === '/') {
  return <>{children}</>;
}
return <AppLayout>{children}</AppLayout>;
```

To oznacza, że **root route `/` omija normalny App Shell**.  
Z kolei `app/(main)/page.tsx` zwraca:

```tsx
import RunControlRoom from "../../components/runs/RunControlRoom";

export default function HomePage() {
  return <RunControlRoom />;
}
```

Czyli:

- `/` = specjalistyczny, gęsty, desktopowy **Control Room**
- `/settings`, `/simulations`, `/visualizations`, `/docs/physics` = klasyczny **AppLayout**

### 6.1. Czy to jest błąd?

**Nie.**  
Błędem nie jest samo posiadanie dwóch shelli.

W produktach eksperckich to bywa wręcz bardzo dobre podejście:

- jeden shell do nawigacji, dokumentacji, konfiguracji, analizy,
- drugi shell do intensywnej pracy narzędziowej.

### 6.2. Gdzie jest problem?

Problem jest w tym, że dziś te dwa shelle sprawiają wrażenie:

- innej marki,
- innego systemu ikon,
- innego języka komponentów,
- innego poziomu dojrzałości designu,
- innej semantyki interakcji.

Czyli zamiast:

> „jedna aplikacja, dwa tryby pracy”

mamy bardziej:

> „dwie różne aplikacje, które przypadkiem dzielą repo”.

### 6.3. Dodatkowy problem UX: nazewnictwo i oczekiwania

W `navigation.tsx` pozycja prowadząca na `/` jest podpisana jako **Dashboard**.  
Tymczasem `/` nie wygląda jak dashboard w klasycznym sensie — to jest właściwie **pełny Control Room / workbench**.

To robi poznawczy zgrzyt:

- użytkownik oczekuje widoku overview,
- dostaje interfejs roboczy typu IDE.

To nie jest detal kosmetyczny. To jest ważny błąd informacji i architektury produktu.

### 6.4. Rekomendacja

Masz tu dwie sensowne drogi:

#### Opcja A — `/` zostaje Control Room

Wtedy:

- zmień etykietę z **Dashboard** na **Control Room** albo **Workspace**,
- a jeśli naprawdę potrzebujesz dashboardu, dodaj osobną trasę `/overview` lub `/dashboard`.

#### Opcja B — `/` staje się prawdziwym dashboardem

Wtedy:

- Control Room przenieś np. na `/control-room`,
- a root wykorzystaj jako widok statusu, sesji, ostatnich runów, telemetrii, quick actions.

### 6.5. Co polecam

Dla Fullmag bardziej naturalna wydaje mi się **Opcja A**:

- `/` = **Control Room**
- reszta tras = zaplecze, analiza, konfiguracja, docs

To pasuje do charakteru produktu.  
Ale wtedy nazewnictwo, ikony, shell contract i visual language muszą to jasno komunikować.

---

## 7. Estetyka i tożsamość wizualna: co już działa dobrze

Raport byłby niesprawiedliwy, gdyby nie podkreślić mocnych stron.  
Fullmag **ma potencjał estetyczny**. I to całkiem duży.

### 7.1. Charakter produktu jest trafiony

W aktualnym kodzie i snapshotach widać spójny kierunek emocjonalny:

- ciemne, techniczne, naukowe środowisko,
- wysokokontrastowy tekst,
- akcenty kojarzące się z analizą, energią, solverem, stanem symulacji,
- poczucie „narzędzia dla eksperta”, a nie landing page SaaS.

To jest dobry fundament.  
Największa wartość Fullmag nie leży w „cukierkowym UI”, tylko w tym, że interfejs może wyglądać jak **poważne narzędzie symulacyjne**.

### 7.2. Dark palette jest wiarygodna

Baza kolorystyczna:

- głębokie granaty,
- slate/bluish surfaces,
- jasny tekst,
- kontrolowane akcenty,

jest po prostu dobra dla tego typu produktu.

To nie jest przypadkowy dark mode.  
To jest dark mode, który ma potencjał być rozpoznawalnym DNA Fullmag.

### 7.3. Control Room ma charakter

Komentarze w CSS mówią wprost o inspiracji desktopowym narzędziem i pro-app chrome.  
To nie jest przypadkowy skład utility klas. To jest świadoma próba zrobienia środowiska roboczego typu IDE / scientific workstation.

To jest wartość i **nie należy jej zniszczyć przez mechaniczne wciskanie wszystkiego do generycznego dashboard style**.

### 7.4. Konkluzja

Problem Fullmag nie brzmi:

> „estetyka jest zła”.

Problem brzmi:

> „estetyka jest obiecująca, ale rozwarstwiona i niesformalizowana”.

---

## 8. Estetyka i kolorystyka: co obecnie nie jest domknięte

### 8.1. Dwie konkurujące rodziny akcentów

W tokenach widać dwa osobne centra ciężkości:

#### Rodzina 1 — systemowa / shellowa

- `--ide-accent`
- `--ide-accent-bg`
- `--ide-accent-text`

To jest chłodny niebieski, bardzo dobry jako **primary action / active state / navigation emphasis**.

#### Rodzina 2 — domenowa / solverowa

- `--am-accent`
- `--am-info`
- `--am-warn`
- `--am-danger`
- `--am-success`

To jest zestaw bardziej „telemetryczny”, z teal, blue, amber, red, green.

Indywidualnie oba światy działają. Problem w tym, że **nie są jasno hierarchizowane**.  
W efekcie użytkownik nie dostaje prostego komunikatu:

- co jest głównym akcentem produktu,
- co jest statusem,
- co jest kolorem domenowym,
- co jest tylko dekoracją.

### 8.2. Moja rekomendacja kolorystyczna

#### Primary accent

Uczyń **niebieski / blue-cyan z rodziny `--ide-accent`** głównym akcentem produktu.

Niech odpowiada za:

- aktywne itemy w nawigacji,
- call-to-action,
- selection state,
- linki / interaktywność,
- aktywny tab,
- focus ring.

#### Secondary / domain accent

Teal (`--am-accent`) może zostać, ale powinien mieć rolę bardziej specjalistyczną:

- highlight danych solvera,
- energy preview,
- wybrane sygnały domenowe,
- ewentualnie secondary action w control room.

#### Semantic colors

- green = sukces / running / healthy
- amber = warning / caution
- red = error / failed / destructive
- blue info = informational
- kolory energii = wyłącznie tam, gdzie rzeczywiście opisują energię

### 8.3. Glass vs matte surfaces

W zwykłym app shellu widać miękki, trochę „glass” charakter kart i powierzchni.  
W control roomie widać bardziej **matte, industrial, technical surfaces**.

Każdy z tych stylów osobno może działać. Razem bez reguł tworzą napięcie.

### 8.4. Co proponuję

Nie robiłbym Fullmag jako czystego glassmorphism.  
To źle pasuje do produktu narzędziowego.

Lepiej zrobić:

- **App Shell**: subtelna głębia, lekki glow w tle, ale same karty bardziej matowe niż szklane
- **Control Room Shell**: twardsze, bardziej płaskie, techniczne surface’y
- wspólne:
  - ten sam kolor tekstu,
  - ta sama rodzina borderów,
  - ten sam primary accent,
  - ta sama semantyka statusów

### 8.5. Light theme jest niedokończony

To jest bardzo ważne globalnie.

`ThemeProvider` obsługuje `dark` i `light`, a `ThemeToggle` umożliwia przełączanie.  
Ale w analizowanym CSS **nie ma kompletnego bloku `[data-theme='light']`**. W praktyce w kodzie jest obietnica produktu, ale nie ma pełnego kontraktu wizualnego.

To powoduje kilka problemów:

- QA designu nie wie, co jest „prawidłowym light mode”,
- komponenty nie mają gwarantowanej semantyki kolorystycznej dla obu theme’ów,
- toggle istnieje w shellu zwykłych stron, ale nie istnieje w Control Roomie,
- użytkownik dostaje nierówny poziom wsparcia theme’u.

### 8.6. Rekomendacja

Masz dwie poprawne drogi:

- **albo** tymczasowo usunąć / ukryć light mode, dopóki nie będzie kompletny,
- **albo** zrobić light mode porządnie dla obu shelli.

Najgorsza opcja to zostawić toggle jako obietnicę bez pełnego wykonania.

---

## 9. Typografia, spacing, rytm, shape language

### 9.1. Typografia

Użycie:

- `Inter`
- `JetBrains Mono`

jest bardzo trafione dla takiego produktu.

To jest dobra para:

- Inter — UI, nawigacja, tekst,
- JetBrains Mono — dane, wartości, identyfikatory, parametry solvera.

### 9.2. Problem: fonty są ładowane podwójnie

W `app/layout.tsx` fonty są wstrzykiwane przez `<head>` jako linki do Google Fonts.  
Jednocześnie `app/globals.css` robi `@import url(...)` dla tych samych fontów.

To powinno zostać uproszczone.

### 9.3. Co proponuję

W Next najlepiej pójść w **`next/font`** i wyrzucić zarówno ręczne linki z `<head>`, jak i `@import` z CSS.  
Zyskasz:

- czystszy root layout,
- bardziej przewidywalny loading,
- mniej dubli,
- lepszą kontrolę nad fallbackami.

### 9.4. Skala typograficzna

Ogólna skala jest całkiem sensowna:

- na zwykłych stronach:
  - tytuły ~24 px
  - body ~14 px
- w control roomie:
  - mniejsze minimum dla dense UI

To jest OK, ale wymaga formalizacji.

### 9.5. Rekomendacja dotycząca gęstości

Powinny istnieć dwa tryby gęstości, ale w jednej rodzinie:

- **Comfortable density** — App Shell
- **Compact density** — Control Room

To jest zdrowe rozróżnienie.  
Niezdrowe jest wtedy, gdy gęstość zmienia się razem z całym językiem komponentów, ikon i barw.

### 9.6. Shape language

W tokenach widać kilka radiusów:

- 6 px
- 10 px
- 14 px
- 20 px
- pill

To jest trochę za dużo jak na aplikację, która chce być rozpoznawalna.

### 9.7. Propozycja

Sprowadziłbym to do prostszego zestawu:

- **8 px** — małe kontrolki
- **12 px** — standardowe karty / inputy / buttony
- **16 px** — duże surface’y lub specjalne panele
- **999 px** — badge/pill

Im mniej odmian, tym bardziej „to wygląda jak jedna marka”.

---

## 10. Ikonografia: mały detal, który zdradza wielki problem

W `components.json` widać `iconLibrary: "lucide"`.  
W projekcie `lucide-react` jest zainstalowane.  
A mimo to część aplikacji używa inline SVG z komentarzami w stylu „no external library needed”.

To jest bardzo wymowny symptom.

### 10.1. Co obecnie widać

#### App Shell / nawigacja

- `navigation.tsx` — inline SVG
- `ThemeToggle.tsx` — inline SVG
- `TopBar.tsx` — inline SVG menu icon

#### Control Room shell

- `TitleBar.tsx`, `MenuBar.tsx`, `RibbonBar.tsx`, `StatusBar.tsx` — `lucide-react`

### 10.2. Dlaczego to jest problem globalny

Ikony są jednym z najmocniej odczuwalnych elementów spójności produktu.  
Różnice w stroke, proporcjach i krzywiznach są bardzo szybko wyczuwalne nawet wtedy, gdy użytkownik nie umie ich nazwać.

Dziś w Fullmag ikony zdradzają, że shell zwykłych tras i control room nie należą do jednej rodziny.

### 10.3. Rekomendacja

Ustaliłbym prostą zasadę:

> **W całej aplikacji używamy Lucide. Wyjątkiem może być wyłącznie brand / logo.**

To natychmiast poprawi spójność bez wielkiego kosztu.

---

## 11. Audit UX: co dziś działa, a co rozbija doświadczenie użytkownika

### 11.1. Co działa

#### Czytelna segmentacja sidebaru

Sekcje typu:

- Execution
- Analysis
- Reference
- System

są sensowne i pasują do produktu.

#### Wyraźny podział między powierzchnią nawigacyjną a contentem

Zwykły AppLayout jest czytelny: sidebar + topbar + main + footer.

#### Control Room ma „narzędziowy” charakter

W specjalistycznym produkcie to ważniejsze niż bycie „ładnym”.

### 11.2. Co nie działa globalnie

#### 1. Root route nie komunikuje swojej roli

Jeśli link w sidebarze mówi „Dashboard”, a użytkownik ląduje w ciężkim środowisku roboczym, to znika przewidywalność.

#### 2. Brak jednego modelu interakcji

W różnych miejscach użytkownik dostaje inne archetypy:

- gdzieś button wygląda jak glass CTA,
- gdzieś jak customowy outline control,
- gdzieś jak surowy natywny button,
- gdzieś jest badge z shadcn,
- gdzieś toggle jest customowy,
- gdzieś checkbox jest raw.

To powoduje, że użytkownik nie buduje pamięci proceduralnej dla interfejsu.

#### 3. Theme nie jest globalny

Theme toggle znajduje się w `TopBar`, czyli w App Shellu, ale nie jest elementem Control Room.  
To symbolicznie pokazuje, że system nie jest globalny.

#### 4. Zwykłe strony i Control Room mają inną gęstość, inny charakter i inny rytm

Samo zróżnicowanie gęstości jest OK.  
Nie-OK jest to, że razem z gęstością zmienia się też:

- typ ikon,
- styl przycisków,
- styl inputów,
- styl surface’ów.

### 11.3. UX principle, który tu trzeba wprowadzić

**Użytkownik ma odczuwać zmianę trybu pracy, a nie zmianę produktu.**

To jest centralna zasada dla Fullmag.

---

## 12. Audit shadcn / Tailwind / Radix

### 12.1. Co jest dobre

Projekt ma już bardzo dobrą bazę techniczną:

- Tailwind v4
- Radix
- `class-variance-authority`
- `clsx`
- `tailwind-merge`
- `lucide-react`
- konfigurację shadcn

To znaczy, że nie trzeba od zera wymyślać infrastruktury.  
Trzeba tylko zdecydować, że od teraz to właśnie ona jest **oficjalnym centrum warstwy UI**.

### 12.2. Co jest dziś słabe

#### shadcn jest obecny, ale nie jest kręgosłupem

To najważniejsze zdanie tej sekcji.

shadcn nie powinien być „kilkoma ładnymi komponentami obok”.  
Powinien być albo podstawą prymitywów, albo nie powinno go być wcale.

Obecnie jest po środku: istnieje, ale nie rządzi.

#### CVA jest praktycznie niewykorzystane

W analizowanym snapshotcie `class-variance-authority` jest realnie użyte praktycznie tylko w `Badge`.

To oznacza, że nie korzystacie jeszcze z jednego z najważniejszych benefitów współczesnej warstwy UI:

- wariantów,
- tone’ów,
- rozmiarów,
- wspólnej semantyki dla komponentów.

#### Brakuje podstawowych prymitywów shadcn jako standardu

Nie widzę centralnych, oficjalnych komponentów typu:

- `button.tsx`
- `input.tsx`
- `select.tsx`
- `card.tsx`
- `textarea.tsx`
- `dialog.tsx`
- `sheet.tsx`
- `separator.tsx`
- `scroll-area.tsx`
- `accordion.tsx`
- `toggle-group.tsx`

To nie znaczy, że wszystkie muszą wejść natychmiast.  
Ale bez tej warstwy będziecie dalej każdą stronę składać trochę inaczej.

### 12.3. Co jest słabe w użyciu Tailwinda

Tailwind nie jest tu problemem sam w sobie.  
Problemem jest sposób użycia.

Na stronach typu `settings`, `simulations`, `visualizations` widać klasy zdefiniowane jako długie stringi:

- `pageStackClass`
- `refreshButtonClass`
- `dashboardLinkClass`
- gridy typu `[grid-template-columns:repeat(auto-fill,minmax(...))]`

To jest szybkie, ale długoterminowo oznacza, że:

- styl komponentów żyje w page file,
- page file zaczyna zawierać mały design system lokalny,
- kolejne strony kopiują i przerabiają te stringi,
- design drift rośnie.

### 12.4. Mój werdykt dot. Tailwinda

**Tailwind powinien służyć do budowania prymitywów i kompozytów, nie do budowania osobnego stylu na każdej stronie.**

Czyli:

- OK: `components/ui/button.tsx`, `components/ui/card.tsx`, `components/composites/page-header.tsx`
- gorzej: każda trasa definiuje swój własny `refreshButtonClass`

### 12.5. Co jest słabe w użyciu Radix

Radix jest częściowo używany bez spójnej warstwy wrapperów.

Przykład:

- MenuBar korzysta bezpośrednio z `@radix-ui/react-dropdown-menu`

To jest technicznie poprawne, ale z punktu widzenia design systemu lepiej mieć **własny standardowy wrapper** lub wzorzec stylowania, żeby kolejne menu nie powstawały od nowa.

---

## 13. Które elementy warto zamienić na shadcn, a które zostawić customowe

To jest jedna z najważniejszych części raportu.

> **Nie wszystko powinno zostać zastąpione przez shadcn.**
>
> shadcn to warstwa prymitywów, nie gotowa wizja produktu.

### 13.1. Elementy, które zdecydowanie warto oprzeć o shadcn / wspólne wrappery

| Obecny stan | Problem | Docelowy kierunek |
|---|---|---|
| `.card`, `.card-header`, `.card-title`, `.card-body` w global CSS | karty istnieją jako styl globalny, nie jako oficjalny komponent | `Card`, `CardHeader`, `CardTitle`, `CardContent`, ewentualnie własny wrapper `SurfaceCard` |
| `Button.tsx` + `.btn*` + lokalne utility strings dla przycisków | kilka standardów buttonów naraz | jeden projektowy `Button` oparty o shadcn/CVA |
| `SelectField.tsx` + raw `<select>` | brak jednego stylu selektów | `Select` oparty o Radix/shadcn |
| `TextField.tsx` + raw `<input>` | brak wspólnego focus/spacing/size contract | `Input` + ewentualny wrapper z unit/mono |
| `Toggle.tsx` + raw checkboxy | różne standardy przełączników | `Switch` jako oficjalny standard |
| `SegmentedControl.tsx` | customowy segment control równolegle do istniejących Tabs | `Tabs` lub `ToggleGroup` |
| `ThemeToggle.tsx` | custom ikona i custom button poza standardem icon button | `Button` variant `ghost` + Lucide icon |
| mobile menu button w TopBar | inline SVG i osobny styl | `Button` icon-only |
| page-level status pills | semantyka niby spójna, ale rozproszona | `Badge` + wspólna mapka wariantów statusów |
| overlay / mobile sidebar patterns | dziś custom | `Sheet` lub wspólny off-canvas pattern |

### 13.2. Elementy, które powinny zostać customowe, ale na wspólnych tokenach

| Element | Dlaczego nie przepisywać 1:1 na shadcn |
|---|---|
| `RunControlRoom` jako cały shell | to nie jest zwykły dashboard; to domenowe środowisko robocze |
| `TitleBar`, `MenuBar`, `RibbonBar`, `StatusBar` | to są komponenty charakterystyczne dla pro-tool / desktop chrome |
| viewport, canvas area, console, split panes | to są powierzchnie robocze, nie generyczne karty |
| study tree / workspace panes | struktura domenowa może wymagać własnych kompozytów |
| duże panele FEM / mesh / preview | logika domenowa jest nietrywialna, ale kontrolki w środku mogą być ze wspólnych prymitywów |

### 13.3. Zasada docelowa

**Customowy ma być layout domenowy. Standardowe mają być interaktywne prymitywy.**

To rozróżnienie rozwiązuje większość sporów „shadcn czy custom”.

---

## 14. Konkretna mapa migracji komponentów

### 14.1. Buttons

#### Dziś

- globalne `.btn`
- custom `Button.tsx`
- page-local klasy typu `refreshButtonClass`
- osobne przyciski w shellach
- raw `<button>` w panelach

#### Problem

Brak jednego standardu:

- rozmiarów,
- tone’ów,
- disabled state,
- focus state,
- destructive state,
- icon-only button,
- link-like button.

#### Docelowo

Zróbcie **jeden projektowy `Button`** oparty o shadcn/CVA z wariantami typu:

- `default`
- `secondary`
- `outline`
- `ghost`
- `destructive`
- `success` (opcjonalnie projektowo)
- `toolbar`
- `ribbon`
- `icon`

Nie oznacza to, że wszystkie muszą wyglądać identycznie.  
Oznacza tylko, że wszystkie mają pochodzić z jednej semantyki.

### 14.2. Cards / surfaces

#### Dziś

- `.card` i rodzina w global CSS
- własne panele w CSS Modules
- shell surfaces w control roomie

#### Problem

Zwykłe strony i control room nie korzystają z tej samej rodziny surface’y.

#### Docelowo

Zbudować 2–3 oficjalne surface’y:

- `Card` / `SurfaceCard` — dla app shell
- `InsetPanel` — dla paneli o większej gęstości
- `WorkbenchSurface` — dla control room / console / viewport sidepanes

Ważne: to nadal może być customowy komponent, ale powinien używać tych samych:

- border tokens,
- radius tokens,
- shadow tokens,
- focus tokens.

### 14.3. Forms

#### Dziś

- `TextField.tsx`, `SelectField.tsx`, `Toggle.tsx`
- dużo raw inputów i selectów
- różne style w `SettingsPanel` i `MeshSettingsPanel`

#### Docelowo

- `Input`
- `Select`
- `Switch`
- `Label`
- `Textarea`
- `Tooltip`
- `Separator`
- `Accordion` dla grup ustawień
- `Tabs` / `ToggleGroup` dla trybów

Jeżeli potrzebne są specyficzne warianty, zróbcie wrappery typu:

- `NumericInput`
- `UnitInput`
- `MonoValueInput`
- `FieldRow`
- `SettingField`

ale nie twórzcie nowego osobnego design systemu.

### 14.4. Navigation

#### Dziś

- custom Sidebar
- inline SVG
- hardcoded logo „F”
- root label „Dashboard”, choć route to Control Room

#### Docelowo

- Lucide jako wspólna ikonografia
- spójne aktywne / hover / focus states
- jawna semantyka route’ów
- ewentualne użycie `ScrollArea`, `Separator`, `Tooltip` dla collapsed nav
- osobny komponent `NavItem` i `NavSection`

### 14.5. Theme toggle

#### Dziś

- customowy `ThemeToggle`
- toggle istnieje w App Shellu, nie w Control Roomie
- light mode nie jest domknięty

#### Docelowo

- albo theme toggle wycofać tymczasowo,
- albo uczynić go globalnym elementem systemu i zakończyć light theme

W obu przypadkach przycisk powinien korzystać z tego samego `Button`/icon-button standardu.

### 14.6. Tabs / segmented controls

`SegmentedControl.tsx` jest dziś osobnym wynalazkiem, podczas gdy istnieje już `tabs.tsx`.  
To jest klasyczny przykład duplikacji.

Jeśli potrzebujesz:

- przełączania widoków,
- wyboru trybu,
- małej grupy opcji wzajemnie wykluczających się,

użyj jednego standardu:

- `Tabs` dla content switching,
- `ToggleGroup` dla prostego segmented control.

### 14.7. Badges / statuses

`Badge` to jedna z bardziej udanych części obecnej warstwy UI.  
Dobrze byłoby z niej zrobić oficjalny wzorzec dla statusów:

- `idle`
- `running`
- `success`
- `warning`
- `error`
- `draft`
- `published`
- `info`

Dziś badge jest używany w stronach, ale statusy w Control Roomie i panelach mają inne wzorce. To trzeba scalić.

---

## 15. File-by-file: co dokładnie zmieniłbym w analizowanych plikach

### 15.1. `app/globals.css`

**Stan dziś:** 1300 linii, ok. 103 unikalnych klas selektorów, plik robi naraz za theme/token/layout/components/utilities.  
**Ocena:** zbyt ciężki, zbyt centralny, zbyt mieszany.

#### Co zrobić

1. Rozdzielić go na:
   - `styles/tokens.css`
   - `styles/themes.css`
   - `styles/base.css`
   - `styles/utilities.css`
2. Usunąć definicje komponentów, które powinny być komponentami React/Tailwind, np. `card`, `btn`.
3. Domknąć custom properties.
4. Usunąć `@import` fontów.
5. Zostawić tu tylko to, co naprawdę globalne.

#### Czego nie robić

Nie robić z `globals.css` dalszego magazynu nowych klas „na szybko”.  
To jest prosty sposób, żeby chaos znów odrósł po refaktorze.

### 15.2. `app/layout.tsx`

#### Co jest OK

- jedno wejście w theme provider
- root layout jako miejsce na font/theme

#### Co zmienić

- przejść na `next/font`
- uprościć head
- zachować tylko to, co globalne

### 15.3. `app/(main)/layout.tsx`

To jest plik, który dziś ujawnia architektoniczny split shelli.  
Trzeba go zostawić albo świadomie przedefiniować.

#### Opcja rekomendowana

Zostawić dwa shelle, ale:

- formalnie nazwać je `AppShell` i `ControlRoomShell`
- nie ukrywać tego jako jednego `if (pathname === '/')`

To może przyjąć np. formę:

- oddzielnych route group,
- lub jawnego layout composition.

### 15.4. `components/layout/navigation.tsx`

To jest miejsce, gdzie dziś widać:

- inline SVG,
- niespójność z Lucide,
- potencjalny problem nazewnictwa `Dashboard`.

#### Co zmienić

- zamienić ikony na Lucide
- zrewidować nazwy tras
- ujednolicić aktywny/hover/focus

### 15.5. `components/theme/ThemeToggle.tsx`

#### Co zmienić

- użyć Lucide
- użyć projektowego `Button`
- nie utrzymywać tego jako odrębnej mini-implementacji

### 15.6. `components/layout/TopBar.tsx`

#### Co zmienić

- mobile toggle jako icon button z tego samego systemu
- topbar powinien używać tego samego spacingu i tokens co reszta nav/shell controls

### 15.7. `components/ui/Button.tsx`

Jeżeli zostaje customowy wrapper — OK.  
Ale powinien zostać oparty o ten sam idiom, co shadcn primitives, czyli:

- Tailwind + CVA
- jasne warianty
- wspólna semantyka
- wsparcie dla icon-only, size, destructive, disabled

Obecna wersja jest bardziej osobnym komponentem niż elementem systemu.

### 15.8. `components/ui/SelectField.tsx`, `TextField.tsx`, `Toggle.tsx`, `SegmentedControl.tsx`

Te komponenty dziś wyglądają jak lokalne rozwiązania dla problemów, które systemowo powinny zostać rozwiązane przez wspólną warstwę form controls.

**Moja decyzja projektowa:**  
nie rozwijałbym ich dalej jako osobnej gałęzi.  
Albo:

- zastąpić je prymitywami shadcn,
- albo przepisać jako wrappery nad tymi prymitywami.

### 15.9. `components/runs/RunControlRoom.tsx` i `RunControlRoom.module.css`

To jest bardzo ważny element produktu i nie należy go traktować jak „dziwny wyjątek do wyrównania”.

#### Co zachować

- charakter workbench / control room
- resizable layout
- technical density
- ribbon / status / console / viewport mental model

#### Co zmienić

- zapiąć go pod wspólny design contract
- zunifikować ikony, buttony, focus, inputs, selects, status chips
- przestać traktować go jak osobne UI kingdom

### 15.10. `components/panels/SettingsPanel.tsx` i `MeshSettingsPanel.tsx`

To są świetne kandydaty do migracji na wspólne prymitywy.

Nie dlatego, że są „brzydkie”, tylko dlatego, że to właśnie tutaj najbardziej widać:

- raw inputs,
- raw selects,
- checkboksy,
- customowe przyciski,
- własną semantykę fieldów.

To jest idealny obszar na etap 2 lub 3 refaktoru.

---

## 16. Największe błędy w wykorzystaniu shadcn / Tailwind

Ta sekcja odpowiada dokładnie na prośbę o wskazanie błędów, ale robi to w perspektywie całości.

### Błąd 1. shadcn jest dodatkiem, a nie szkieletem

To najważniejszy błąd.

Jeśli projekt ma shadcn, Radix i Tailwind, ale większość systemu nadal jest składana jako:

- global CSS,
- CSS Modules,
- custom atomy,
- raw controls,

to shadcn pełni rolę dekoracyjną, a nie systemową.

### Błąd 2. Dublowanie problemów rozwiązanych już przez Radix/shadcn

Przykłady:

- custom `Toggle` mimo obecności `Switch`
- custom `SegmentedControl` mimo obecności `Tabs` i możliwości dodania `ToggleGroup`
- custom/native `Select` mimo zainstalowanego `@radix-ui/react-select`
- page cards jako global CSS zamiast oficjalnego `Card`

### Błąd 3. Tailwind wykorzystywany na poziomie stron jako lokalny mikro-system

Długie stringi utility klas w plikach stron są przydatne w prototypowaniu, ale nie powinny stać się standardem produktu.

### Błąd 4. Brak warstwy kompozytów

Między prymitywami a stroną powinny istnieć kompozyty, np.:

- `PageHeader`
- `SectionCard`
- `MetricTile`
- `SettingRow`
- `ToolbarButton`
- `ControlGroup`
- `FormSection`

Dziś część tej roli pełnią globalne klasy, część raw JSX, część CSS modules.

### Błąd 5. Niespójna ikonografia mimo gotowej biblioteki

To nie jest drobiazg. To jeden z najtańszych do naprawy i najbardziej opłacalnych globalnie problemów.

### Błąd 6. Theme bez pełnej realizacji

W design systemie theme nie może być „może zadziała”.  
Albo jest skończony, albo jest wyłączony.

---

## 17. Czego absolutnie nie robić od teraz

To jest bardzo ważna sekcja, bo dokładnie odpowiada na Twój cel: **uniknąć błędu poprawiania małego elementu kosztem całej aplikacji.**

### Zasada 1

**Nie projektować nowych atomów UI bez decyzji, czy są częścią wspólnego systemu.**

Jeżeli ktoś potrzebuje nowego buttona, inputa, selecta, badge’a, panelu czy toggle’a, to pierwsze pytanie brzmi:

> czy to jest nowy wariant istniejącego prymitywu, czy właśnie tworzymy kolejny równoległy system?

### Zasada 2

**Nie dodawać nowych inline SVG, jeśli projekt ma Lucide.**

### Zasada 3

**Nie dopisywać nowych globalnych klas komponentowych do `globals.css`, jeśli coś powinno być komponentem React.**

### Zasada 4

**Nie tworzyć lokalnych utility stringów jako trwałej architektury strony.**

Jeżeli dana klasa jest używana dłużej niż chwilę lub w więcej niż jednym miejscu, powinna awansować do komponentu lub wrappera.

### Zasada 5

**Nie rozwijać light mode po kawałku.**

Light mode jest systemem, nie serią pojedynczych poprawek.

### Zasada 6

**Nie refaktorować Control Roomu na siłę do stylu „dashboard cards everywhere”.**

Control Room ma prawo być gęstszy, bardziej techniczny i bardziej narzędziowy.  
Musi tylko mówić tym samym językiem design tokenów i interakcji.

---

## 18. Model docelowy: jak powinno to wyglądać po unifikacji

### 18.1. Architektura warstw

#### Warstwa 1 — tokens

Jedno źródło prawdy dla:

- colors
- spacing
- radii
- shadows
- typography
- motion
- focus
- z-index
- density

#### Warstwa 2 — primitives

Jedna biblioteka prymitywów, najlepiej w `components/ui`, oparta o shadcn/Radix/Tailwind:

- `Button`
- `Input`
- `Select`
- `Textarea`
- `Switch`
- `Tabs`
- `Badge`
- `Tooltip`
- `Card`
- `Separator`
- `Dialog`
- `Sheet`
- `ScrollArea`
- `Accordion`
- `ToggleGroup`

#### Warstwa 3 — composites

Komponenty projektowe:

- `PageHeader`
- `SectionCard`
- `MetricTile`
- `StatusBadge`
- `ToolbarButton`
- `FormSection`
- `FieldRow`
- `SidebarNavItem`
- `AppBreadcrumbs`

#### Warstwa 4 — shells

Dwa oficjalne shelle:

- `AppShell`
- `ControlRoomShell`

Oba korzystają z tych samych warstw 1–3.

### 18.2. Ważna filozofia

To nie ma być:

> „wszędzie wrzucamy surowe komponenty shadcn”

To ma być:

> „shadcn daje nam techniczne prymitywy, a Fullmag nakłada na nie własny charakter produktu”.

---

## 19. Proponowana tożsamość stylistyczna Fullmag

Jeżeli mam ubrać docelowy styl Fullmag w jedno zdanie, to brzmiałoby ono tak:

> **Scientific Workbench, nie SaaS Dashboard.**

### 19.1. Co to oznacza w praktyce

#### Brand feeling

- precyzyjny
- ekspercki
- stabilny
- techniczny
- wiarygodny
- spokojny, nie krzykliwy

#### Surface language

- ciemne, techniczne tła
- ograniczona ilość glow
- mało „szkła”
- dużo czytelnych, cienkich borderów
- dobra hierarchia głębokości

#### Color hierarchy

- niebieski = primary interaction
- teal = secondary/domain highlight
- green/amber/red = semantyka statusów
- energy palette = tylko dla danych fizycznych

#### Shape language

- umiarkowane radiusy
- brak nadmiernego zaokrąglenia
- precyzyjna geometria

#### Motion

- subtelne transition
- brak „marketingowej animacyjności”
- interakcje mają wzmacniać kontrolę, nie show

---

## 20. Roadmap refaktoru — kolejność prac

To jest najważniejsze z punktu widzenia wdrożenia.  
Refaktor trzeba robić tak, żeby poprawiać całość, a nie tylko „mieć ładniejszy ekran”.

### Faza 0 — zatrzymanie dryfu

**Cel:** nie dopuścić do dalszego rozchodzenia się stylu.

Do zrobienia:

1. Ustalić oficjalnie, że są dwa shelle: `AppShell` i `ControlRoomShell`.
2. Zdecydować, czy `/` to Dashboard czy Control Room.
3. Ustalić jedną bibliotekę ikon: Lucide.
4. Ustalić, że nowe podstawowe kontrolki nie powstają już jako osobne customowe wynalazki.
5. Zdecydować: light mode kończymy albo wyłączamy.
6. Zamrozić dopisywanie nowych klas komponentowych do `globals.css`.

### Faza 1 — zbudowanie oficjalnych prymitywów

**Cel:** stworzyć wspólny język UI.

Priorytet:

- `Button`
- `Card`
- `Input`
- `Select`
- `Switch`
- `Badge`
- `Tabs`
- `Tooltip`
- `Separator`
- `Sheet`
- `Dialog`
- `ScrollArea`
- `Accordion`
- `ToggleGroup`

Każdy z tych komponentów powinien mieć:

- warianty,
- rozmiary,
- focus state,
- disabled state,
- token-driven kolory.

### Faza 2 — ujednolicenie App Shellu i zwykłych tras

Najpierw warto migrować obszary najłatwiejsze i najbardziej widoczne:

- `Sidebar`
- `TopBar`
- `ThemeToggle`
- `navigation.tsx`
- strony:
  - `/settings`
  - `/simulations`
  - `/visualizations`
  - `/docs/physics`

To daje szybki wzrost spójności globalnej.

### Faza 3 — migracja paneli formularzowych w Control Roomie

Potem przejść do:

- `SettingsPanel.tsx`
- `MeshSettingsPanel.tsx`
- `FemWorkspacePanel.tsx`

Tu największy zysk da wymiana raw controls na wspólne prymitywy.

### Faza 4 — uproszczenie CSS

Na końcu:

- odchudzić `globals.css`,
- wyciąć martwe lub zduplikowane wzorce,
- zostawić tylko tokeny/base/utilities,
- shell-specific CSS przenieść tam, gdzie ma sens.

---

## 21. Priorytety P0 / P1 / P2

### P0 — krytyczne dla spójności

- uporządkować nazewnictwo `/`
- ujednolicić ikonografię na Lucide
- przestać rozwijać równoległe atomy
- zdecydować o light mode
- ustalić docelowy primary accent

### P1 — duży zysk / niski koszt

- zbudować `Button`, `Card`, `Input`, `Select`, `Switch`
- przepisać `ThemeToggle` i `TopBar`
- zastąpić page-level utility stringi komponentami kompozytowymi
- migrować zwykłe strony do wspólnych surface’ów

### P2 — większy koszt / duży zysk strategiczny

- migracja Control Room forms
- uproszczenie `globals.css`
- formalne rozdzielenie `AppShell` i `ControlRoomShell`
- pełne domknięcie themingu

---

## 22. Konkretne propozycje komponentów docelowych

Poniżej pokazuję zestaw komponentów, które dają największy efekt globalny.

### 22.1. `Button`

Warianty:

- `default`
- `secondary`
- `outline`
- `ghost`
- `destructive`
- `toolbar`
- `icon`

Rozmiary:

- `sm`
- `md`
- `lg`
- `icon`

### 22.2. `Card` / `SurfaceCard`

Warianty:

- `default`
- `muted`
- `inset`
- `flat`
- `workbench`

### 22.3. `Input`

Warianty:

- `default`
- `mono`
- `withUnit`

### 22.4. `StatusBadge`

Nie wystawiałbym wszędzie surowego `Badge variant="..."`.  
Lepiej mieć wrapper:

```tsx
<StatusBadge status="running" />
<StatusBadge status="error" />
<StatusBadge status="published" />
```

To scala semantykę całej aplikacji.

### 22.5. `PageHeader`

Zamiast ciągle używać:

- `page-header`
- `page-title`
- `page-subtitle`

warto mieć kompozyt:

```tsx
<PageHeader
  title="Settings"
  subtitle="Platform configuration and live workspace state"
  actions={<Button>Refresh</Button>}
/>
```

### 22.6. `FormSection` i `FieldRow`

To będzie bardzo przydatne w Control Roomie, bo właśnie tam dziś najłatwiej o chaos.

---

## 23. Decyzja strategiczna: pełny shadcn wszędzie czy dwa shelle na wspólnym szkielecie?

Tu warto powiedzieć to bardzo jasno.

### Opcja 1 — poprawiamy tylko pojedyncze widoki

**Odradzam.**  
To najszybsza droga do jeszcze większego rozjazdu.

### Opcja 2 — wszystko bez wyjątku przepisać „na shadcn”

**Też odradzam.**  
To może zabić charakter Control Roomu i spłaszczyć produkt do zwykłego dashboardu.

### Opcja 3 — dwa shelle, jeden design backbone

**To rekomenduję.**

Czyli:

- shadcn/Radix/Tailwind jako warstwa prymitywów,
- Fullmag-specific wrappers jako kompozyty,
- dwa spójne shelle nad tym samym systemem.

To daje:

- spójność,
- skalowalność,
- zachowanie specjalistycznego charakteru Control Roomu,
- łatwiejsze wdrażanie kolejnych ekranów.

---

## 24. Najważniejsze quick wins

Jeśli miałbym wskazać rzeczy, które dają duży efekt bez gigantycznego refaktoru, to byłyby to:

1. **zmienić `Dashboard` na `Control Room`** albo wydzielić prawdziwy dashboard,  
2. **wyrównać całą ikonografię do Lucide**,  
3. **wyłączyć albo dokończyć light mode**,  
4. **zbudować jeden oficjalny `Button`**,  
5. **zbudować jeden oficjalny `Card`**,  
6. **przestać definiować przyciski jako lokalne utility stringi w page files**,  
7. **zastąpić raw select/input/toggle w panelach wspólnymi prymitywami**,  
8. **podzielić `globals.css` na mniejsze warstwy**,  
9. **usunąć podwójne ładowanie fontów**,  
10. **sformalizować dwa shell’e jako element produktu, a nie wyjątek techniczny**.

---

## 25. Finalny werdykt

Fullmag nie potrzebuje dzisiaj kosmetycznego „UI polishu”.  
Fullmag potrzebuje **decyzji systemowej**.

### Mój finalny wniosek w jednym akapicie

Obecny frontend ma bardzo dobry potencjał wizualny i trafny kierunek produktowy — szczególnie w warstwie dark, scientific, pro-tool. Problem nie leży w tym, że „coś jest brzydkie”, tylko w tym, że aplikacja składa się z kilku niesformalizowanych języków UI: globalnego CSS, własnych CSS Modules, fragmentów shadcn/Radix/Tailwind oraz raw controls. Dodatkowo `/` działa jak osobny świat względem reszty tras. Dlatego najlepszą strategią nie jest poprawianie pojedynczych ekranów, ale zbudowanie jednego design backbone: wspólnych tokenów, wspólnych prymitywów i dwóch spójnych shelli — App Shell oraz Control Room Shell. Dopiero na takim szkielecie ma sens dalsze dopieszczanie estetyki.

### Najkrótsza rekomendacja

> **Nie ujednolicać wszystkiego na siłę do jednego layoutu.**
>
> **Ujednolicić system, a nie pozory.**

---

## 26. Appendix A — najważniejsze sygnały z kodu

### 26.1. `globals.css` jest zbyt centralny

- linie: **1300**
- unikalne klasy selektorów: **103**
- uwaga: **tokeny + reset + layout + komponenty + utility; 23 nie-zdefiniowane custom properties w samym pliku**

### 26.2. `RunControlRoom.module.css` to osobny świat wizualny

- linie: **1398**
- unikalne klasy selektorów: **136**
- uwaga: **duży, autonomiczny świat desktop/IDE**

### 26.3. `shell.module.css` ma własny desktop chrome

- linie: **668**
- unikalne klasy selektorów: **52**
- uwaga: **własny chrome inspirowany aplikacją desktopową**

### 26.4. Duże panele domenowe są dziś naturalnym miejscem do migracji prymitywów

- `SettingsPanel.tsx` — **941** linii  
- `MeshSettingsPanel.tsx` — **517** linii

---

## 27. Appendix B — przykłady źródłowych sygnałów architektonicznych

### 27.1. Root route omija `AppLayout`

```tsx
// app/(main)/layout.tsx
if (pathname === '/') {
  return <>{children}</>;
}
return <AppLayout>{children}</AppLayout>;
```

### 27.2. Root route renderuje Control Room

```tsx
// app/(main)/page.tsx
import RunControlRoom from "../../components/runs/RunControlRoom";

export default function HomePage() {
  return <RunControlRoom />;
}
```

### 27.3. shadcn jest skonfigurowany, ale tylko częściowo adoptowany

```json
{
  "style": "new-york",
  "tailwind": {
    "baseColor": "slate",
    "cssVariables": true
  },
  "iconLibrary": "lucide"
}
```

### 27.4. App shell używa inline SVG mimo obecności Lucide

```tsx
/* ── Inline SVG Icons (no external library) ── */
```

oraz:

```tsx
/** Inline SVG sun/moon toggle, no icon library needed. */
```

### 27.5. Light theme jest obiecywany, ale nie jest domknięty w CSS

W ThemeProvider istnieją oba tryby:

```tsx
type Theme = 'dark' | 'light';
```

Natomiast w analizowanym `globals.css` nie ma kompletnego bloku `[data-theme='light']`.

### 27.6. Strony tworzą lokalne utility stringi zamiast korzystać z jednego zestawu kompozytów

Przykład z `settings_page.tsx`:

```tsx
const pageStackClass = "flex flex-col gap-[var(--sp-4)]";
const refreshButtonClass = "inline-flex items-center rounded-md border border-[var(--ide-border-subtle)] bg-[var(--surface-2)] px-3 py-1.5 text-[length:var(--text-sm)] font-medium text-[var(--text-soft)] transition-colors hover:bg-[var(--surface-3)] hover:text-[var(--text-1)]";
```

To samo zjawisko widać też w `simulations_page.tsx` i `visualizations_page.tsx`.

---

## 28. Appendix C — recommended folder direction

Nie traktuję tego jako jedynej słusznej struktury, ale jako sensowny kierunek:

```txt
apps/web/
  app/
    layout.tsx
    (app)/
    (control-room)/
  components/
    ui/
      button.tsx
      card.tsx
      input.tsx
      select.tsx
      switch.tsx
      tabs.tsx
      badge.tsx
      tooltip.tsx
      sheet.tsx
      dialog.tsx
      separator.tsx
      scroll-area.tsx
      accordion.tsx
      toggle-group.tsx
    composites/
      page-header.tsx
      section-card.tsx
      metric-tile.tsx
      status-badge.tsx
      field-row.tsx
      form-section.tsx
    shells/
      app-shell/
      control-room-shell/
  styles/
    tokens.css
    themes.css
    base.css
    utilities.css
```

---

## 29. Ostatnia rekomendacja produktowa

Gdybym miał zostawić tylko jedno zdanie dla zespołu, to byłoby to:

> **Od tej chwili każda zmiana w UI musi być oceniana nie tylko pytaniem „czy wygląda lepiej?”, ale przede wszystkim pytaniem „czy przybliża nas do jednego wspólnego systemu?”.**

To jedno kryterium uchroni projekt przed najczęstszym błędem:  
**lokalne upiększanie, które globalnie zwiększa chaos.**