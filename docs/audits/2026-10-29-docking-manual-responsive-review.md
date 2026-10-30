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

Status: **3/3 zakończone — review, poprawki i weryfikacja PASS.** Dowód layoutu na telefonie
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
uchwytu. Odczyt CSSOM potwierdził pierwszeństwo warstwy `fm-primitives` nad
`fm-base`, niezależne od specyficzności selektora. Uchwyt ustawia teraz
lokalny token rozmiaru używany przez Button, bez `!important`.
Końcowy probe wymaga fizycznych wymiarów minimum 32×32 px.

Reset na wąskim ekranie przywraca domyślny drawer Inspectora, który nakłada
się na część widoku. Próba używa istniejącego przycisku „Hide Inspector”
przed kliknięciem odsłoniętego presetu; nie używa force-click ani klikania
pod nakładką. Jawne dokowanie pozostaje dostępną alternatywą.

## Wyniki

- Browser: wszystkie szerokości 1600, 1180, 895, 640, 390 px bez poziomego
  overflow dokumentu; wszystkie zmierzone uchwyty 32×32 px.
- 895 px, Inspector: `docked → reload → docked`.
- Tytuł: klik pozostawia `docked`; przeciągnięcie daje `floating`; Escape
  przywraca `docked`; ponowne przeciągnięcie i drop przy krawędzi daje `docked`.
- Tooltip zawiera instrukcję gestu, Escape i alternatywy klawiatura/menu.
- Pusty preset przy 895 px po schowaniu domyślnego drawera: widok ma
  710,8×531,6 px, mimo dodatkowej podpowiedzi wyboru wyniku.
- Zero pageerror i zablokowanych mutacji w próbie responsywnej.
- [CI 40790131450](https://github.com/MateuszZelent/fullmag/actions/runs/40790131450):
  **1453 testy / 63 pliki**, typecheck i kontrola architektury PASS dla logiki
  `e93f0706338fac2c9c68566359c69c155573885e`. Późniejsza korekta wyłącznie
  lokalnego tokenu rozmiaru CSS jest objęta pomiarem przeglądarkowym.

[Pełne pomiary i hashe artefaktów](2026-10-29-docking-manual-responsive-review.evidence.json).
Zakres responsywności to układ i obsługa gestów; nie jest to benchmark FPS
na fizycznym GPU. Próby nie uruchamiają nowych obliczeń.

[Zrzut wąskiego widoku po użyciu presetu](/mnt/c/Users/Mateusz/.codex/visualizations/2026/10/26/01a1770e-c06b-7282-9514-c818c5e8dfc1/docking-responsive-20261029/verified/narrow-preset.png).

## Instrukcja ręcznej obsługi

1. Przytrzymaj lewy przycisk na uchwycie z kropkami albo tytule panelu
   (jeżeli nagłówek zawiera tytuł; zakładki zachowują własną funkcję).
2. Przeciągnij do krawędzi workspace albo innego panelu. Niebieski podgląd
   wskazuje obszar zajęty po upuszczeniu; puść przycisk w tym obszarze.
3. Przeciągaj separator między panelami, aby zmieniać proporcje.
4. Escape podczas przeciągania przywraca poprzednie położenie.
5. Alternatywnie użyj menu `…` → `Dock to ... of workspace`. Preset
   `Modes | Spectrum` ustawia 3D po lewej i Analysis po prawej.
6. Na wąskim ekranie domyślny Inspector jest nakładką. Użyj jego przycisku
   `Hide Inspector`, aby odsłonić widok, albo zadokuj go jawnie. Taki wybór
   dokowania jest teraz zachowywany także po odświeżeniu.


## Regresja na opublikowanym modzie

`verify_eigensolve_workspace_docking_ui.mjs` PASS: 10 checkpointów, zachowane
instancje 3D, wykresu, Inspectora, Explorera i diagnostyki, resize obu osi,
sześć przeniesień, zapis/odtworzenie, kompaktowe dokowanie i reset. Każdy
checkpoint ma widoczny canvas z niezerowym drawing buffer i niezagubionym
WebGL; zero pageerror i prób mutacji solvera. Załadowano 5127 zespolonych
wartości modu FEM dla zachowanego run_id; nie obliczano nowego wyniku.

Nie zmieniono hashy 14 plików wcześniejszego WIP. Aktywny solver i wydajność
fizycznego GPU pozostają poza zakresem tego browser proof (SwiftShader).

[Mod i wykres po wszystkich operacjach](/mnt/c/Users/Mateusz/.codex/visualizations/2026/10/26/01a1770e-c06b-7282-9514-c818c5e8dfc1/docking-responsive-20261029/mode-regression/final-modes-spectrum-inspector.png).
