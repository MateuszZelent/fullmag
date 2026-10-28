# Ręczne dokowanie i responsywność — review

## Zakres

Obsługa myszą, klawiaturą i czytelność dokowania całego workspace.
Kontrola na dedykowanym UI `localhost:3217`; bez Solve, zmian solvera,
resetowania danych i restartowania kontenerów.

## Znalezione problemy

| Problem | Dowód przed poprawką | Korekta |
| --- | --- | --- |
| Ciągnięcie za tytuł nie przesuwa panelu | Browser: `titleDrag=docked`; handlers tylko na przycisku GripVertical | Przeciąganie za tytuł i puste miejsce nagłówka, z wyłączeniem przycisków, zakładek, pól i elementów interaktywnych |
| Słabo opisany mały uchwyt | Browser: 28×28 px, opis tylko o strzałkach | Minimum 32×32 px, tooltip z instrukcją przeciągania, Escape i menu |
| Dock na wąskim ekranie ginie po reload | Browser 895 px: przed reload docked, po reload floating | Osobny walidowany zapis jawnego dokowania; reset przywraca automatyczne drawers |
| Przyciski paska konkurują o szerokość | Flex bez wrap, tablista kurczy się do zera | Zawijanie paska, elastyczna lista zakładek |
| Podpowiedź wyniku zabiera wiersz widoku | Grid definiował dwa wiersze, choć hint dodaje trzecie dziecko | Kolumna flex: pasek i hint mają własną wysokość, widok zajmuje resztę |
| Bardzo wąski pas dokowania całego workspace | Tylko 12 px | 20 px; podgląd nadal rozróżnia workspace i sąsiedni panel |

Pointer capture należy do elementu rozpoczynającego gest. Bąbelkowanie
zdarzenia z uchwytu do nagłówka nie może wykonać gestu drugi raz. Sam klik
nie odrywa panelu; Escape wraca do pierwotnego trybu i geometrii. Zakładki
nadal zachowują własne akcje. Zmiana nie przenosi rodziców modułów w React.

## Weryfikacja

1. Model preferencji: walidacja i deduplikacja, poprawne odtworzenie i
   odrzucenie uszkodzonych danych. Testy wyłącznie w GitHub Actions.
2. Browser: 1600, 1180, 895, 640 i 390 px; pomiar overflow i uchwytów,
   odświeżenie wąskiego okna, klik tytułu, przeciągnięcie, Escape, tooltip,
   faktyczne upuszczenie przy krawędzi, reset i pusty preset Modes | Spectrum.
3. Browser z opublikowanym modem: istniejąca próba wszystkich paneli,
   zmiany rozmiarów, tożsamości canvasów i niezagubionego WebGL.

Status: implementacja gotowa; weryfikacja w toku. Dowód layoutu na telefonie
nie oznacza, że kilka równoległych paneli ma tam ergonomię dużego monitora.

## Korekty wykryte podczas wykonywania próby

Pierwsza próba nowej obsługi nagłówka wykryła przechwytywanie pointerdown
z elementów menu renderowanych w portalu: zdarzenie bąbelkowało w drzewie
React, mimo że menu nie jest potomkiem nagłówka w DOM. Potwierdzone w
[oficjalnej dokumentacji React createPortal](https://react.dev/reference/react-dom/createPortal)
przez Context7. Nagłówek sprawdza teraz `currentTarget.contains(target)`;
nie tłumi cudzych zdarzeń i nie zamienia wyboru menu w ruch panelu.
Browser probe sprawdza rzeczywiste kliknięcie menu i zmianę trybu.

Pomiar stylów wskazał też, że ogólny wariant przycisku icon nadpisywał minimum
uchwytu. Selektor uchwytu otrzymał właściwą specyficzność bez `!important`.
Końcowy probe wymaga fizycznych wymiarów minimum 32×32 px.
