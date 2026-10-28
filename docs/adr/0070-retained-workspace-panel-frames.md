# ADR 0070: Stable workspace panel frames

- Status: accepted
- Date: 2026-10-26

## Context

Ukrycie kolumny usuwało jej poddrzewo React. Lokalny draft Inspectora, focus i scroll mogły zniknąć mimo zachowania sesji backendu. Osobny ogólny nagłówek docka powielał zakładki modułu. Audyt wymaga wspólnej ramy i swobodnego układu bez utraty pracy.

## Decision

Explorer, Inspector, centralny host i dock diagnostyczny otrzymują jedną ramę `PanelFrame`. Ramka pozostaje w tym samym miejscu drzewa React podczas dock/float/maximize/hide; pozycję zmienia CSS, bez portalu i reparentingu. `PanelChrome` łączy uchwyt, tytuł lub tabs i menu w jednym wierszu. Drag nie obejmuje zakładek ani formularzy. Menu ma alternatywę przesunięcia kolumn, a uchwyty float/resize obsługują strzałki i Shift.

Hide i minimize zachowują lokalny stan oraz DOM. Explorer i dock używają React Activity do zawieszenia efektów. **Inspector zachowuje efekty**: jego rejestr pending form i guard zmiany zaznaczenia muszą pozostać aktywne także po schowaniu. Nie deklarujemy zerowej aktywności zasobów ukrytego Inspectora. Panel przywraca zapamiętany scroll i focus; panele boczne i dock mają dostępne przyciski Restore.

Kolumny i dock są zwijane do zera przez `react-resizable-panels`; ich komponenty pozostają zamontowane. Preferencje geometrii/trybu są lokalne per panel w `fullmag.workspace.panel.<slot>.v1`. Zapis nie zawiera danych naukowych. Reset layoutu przywraca docked. Przy szerokości poniżej 1180px Inspector przechodzi do szuflady, poniżej 760px także Explorer; ustawienie użytkownika pozostaje zachowane do powrotu szerokości.

Kontrakt centralny ADR 0016 otrzymuje jawny wyjątek dla istniejącego companion: host montuje aktywny moduł i najwyżej jeden jawnie wybrany, różny companion, każdy jeden raz. Pozostałe ciężkie moduły są odmontowane. Retencja bocznych paneli nie uprawnia do przechowywania niewybranych WebGL/ECharts powierzchni. Pozostaje co najwyżej jeden moduł 3D i jeden jego canvas. Żadna akcja ramy nie wysyła Stop ani Solve.

### Uzupełnienie 26.10.2026 (poprawki odbioru PR #268)

Centralny host (`viewport-main`) jest przypięty w docku: jego rama nie oferuje float, maximize ani hide, a zapisany wcześniej tryb floating/maximized jest ignorowany, bo odczepienie zostawiało pustą kolumnę w środku workspace. Menu ramy ma jedną akcję „Hide panel” (Minimize/Hide/Close wywoływały tę samą operację). Moduł może dołożyć własne pozycje do tego menu przez `PanelChrome menuItems` i ukrywać panel przez `hideWith`, zachowując retencję focusu i scrolla ramy; Inspector ma więc jeden wiersz chrome i jedno menu. Na wąskim ekranie szuflada Explorera otwiera się od lewej, Inspectora od prawej.

## Consequences

Nie zmieniają się Python, ProblemIR, OpenAPI, generated types, resource hooks, command ID ani dane solvera. Wspólny workspace nie rozdziela FDM/FEM. Zachowanie formularzy jest ważniejsze od usunięcia wszystkich subskrypcji ukrytego Inspectora. Ciężkie wykresy docka nadal montowane są tylko dla aktywnej karty.

## Implementation obligations and validation

`WorkspaceDockLayout`, `PanelFrame`, wspólny Resizable i nagłówki Explorer/Inspector/Viewport/Footer realizują ramę. Spec 01/10/14 opisują różnicę retencji paneli i aktywnych powierzchni. Browser regression musi potwierdzić tę samą tożsamość DOM/draft przy hide/restore i dock/float/maximize, geometrię oraz klawiaturę. Zmiana centralnego chrome wymaga widocznego canvasu, nieutraconego kontekstu i niezerowego drawing buffer. Wyniki i brakujące bramki są zapisywane w planie zadania, nie wynikają ze statusu ADR.

## Rollback

Przy regresji wrócić do docked i zachować stan formularza; nie przywracać destrukcyjnego unmount jako obejścia. Stare preferencje kolejności kolumn są nadal czytane. Nowe klucze geometrii są opcjonalne i mogą zostać zignorowane przez starszy frontend. Wyłączenie companion usuwa wyłącznie dodatkowy moduł, bez zatrzymania sesji.
