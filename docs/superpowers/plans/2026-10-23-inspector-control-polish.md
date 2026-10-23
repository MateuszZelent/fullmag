# Spójne kontrolki wszystkich Inspectorów

Zakres: wspólne prymitywy i wszystkie znalezione obejścia w Inspectorach;
kolory Object/Planar/Frequency Domain, bez zmiany fizyki i API.

Wzorzec wskazany przez użytkownika: istniejące zakładki Visualize. Jeden motyw
Inspectora narzuca wspólne fonty, odstępy, kolory i strukturę wszystkim panelom;
Tailwind konsumuje semantyczne tokeny aplikacji w jasnym i ciemnym szablonie.
Recepta pól w `inspector-theme.css` używa `@apply`, a `tailwind-theme.css`
eksportuje nazwy `fm-inspector-*`. Zmieniony panel nie tworzy własnej palety.

Kierunek: gęsty, czytelny panel właściwości aplikacji naukowej. Zachowujemy
Catppuccin Mocha/Latte i istniejące fonty. Pola 30 px, wartości 12 px normal,
etykiety 12 px medium; delikatna powierzchnia i obramowanie, akcent tylko przy
focus. Mono pozostaje dla jawnych identyfikatorów/kodu, liczby tabularne.
Kontrolki zachowują miejsce na jednostki, caret i długie wartości. Wąski
Inspector układa etykietę nad polem. Nie zmieniamy rozmiaru przycisków ribbon.

1. Root: wspólna recepta CSS dla input/select/textarea, geometryczne tokeny
   Inspectorów, usunięcie konkurencyjnej recepty z FormField i QuantityUnitSelect,
   stany disabled/error/focus/readonly, szerokość i układ wrapperów.
2. Worker input: 17 błędnie ubranych selectów, Dataset Values, Study restore.
3. Worker color: wspólny ColorField, Object General i usunięcie duplikatów.
   Tekst zachowuje tokeny i puste wartości; picker nie zapisuje fallbacku sam.
   Opacity pozostaje osobno; istniejące Apply i mutacje pozostają właścicielami.
4. Root: review zmian, source gates w grupie Compose tego worktree, render
   light/dark przy szerokości szerokiej i wąskiej oraz stany pól/kolorów.
   Brak renderu oznacza NOT VERIFIED, nie pozytywną ocenę wyglądu.
5. Po zakończeniu zakresu aktualizacja PR #249 do master, wymagane CI/review
   i dalszy cykl integracji według reguł repozytorium.

Kryteria: brak tekstowych pól koloru bez pickera w zinwentaryzowanych panelach;
brak selectów z klasą input; jednolita typografia i stany; zachowane drafty,
jednostki, aria-label/describedby/invalid, focus i blokady pending. Lokalnie nie
kompilujemy i nie wykonujemy TS/Rust unit tests. Testy zachowania w CI są wymagane.

Inwentaryzacja: 40 bezpośrednich zwykłych kontrolek w 11 plikach, 17 selectów
z klasą input, 21 pól w wrapperze bez CSS, 1 nieubrane pole Dataset Values,
1 osobny Study restore; dodatkowo wspólny QuantityUnitSelect. ColorField jest
dzisiaj współdzielony przez import z panelu; Object General ma dwa pola bez
pickera, Frequency Domain własną zduplikowaną parę picker/tekst.
