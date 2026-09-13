# Plan refaktoryzacji frontendu Fullmag — 12.09.2026

## 1. Cel i zasady wykonania

Plan wynika z [generalnego audytu](../../reports/2026-09-12/frontend-general-audit.md) dla HEAD `f2b796c8a075b2e67a2d2f844d25fb5cd647ba93`, brancha `fix/viewport-3d-audit-s18-s19-upload-20260910`, wraz z zastanym dirty stanem. Realizację rozpoczęto po ponownym sprawdzeniu aktualnego `master` i wykonano w izolowanym worktree. Findings pozostają rozdzielone na poprawki źródłowe, testy oraz dowody runtime/browser/kwalifikacji; brakująca bramka nie jest zamykana samym kodem.

Celem jest spójny, czytelny instrument naukowy, w którym użytkownik potrafi utworzyć lub otworzyć model, zrozumieć możliwości runtime, edytować bez utraty kontekstu, uruchomić wspierany etap i wiarygodnie odczytać lub wyeksportować wynik. Zachować jeden workspace, viewport, command registry, typowany klient i resource hooks. Nie przepisywać całej aplikacji ani nie tworzyć odrębnych drzew FDM/FEM.

Nie planuje się zmiany fizyki, jednostek, Python DSL, ProblemIR lub domyślnej jakości obrazu jako metody przyspieszania. Jeżeli dany etap ujawni potrzebę zmiany publicznego kontraktu, najpierw opisać ją w odpowiednim spec/ADR i dokumentacji naukowej. Zmiana takich decyzji nie jest kosmetyczną refaktoryzacją.

Każdy etap ma własne kryterium odbioru. Etap nie jest ukończony przez sam commit lub zielony tsc. Kolejność daje pierwszeństwo poprawności i odzyskiwaniu kontroli nad UI, następnie jakości systemu wizualnego, kosztom wykonania oraz kwalifikacji.

## 2. Warunki startowe i organizacja

1. Zastosować `using-git-worktrees` i cykl z `docs/guides/fullmag-build-storage-governance.md`. Implementację wykonano w izolacji zadania z rozwiązanego głównego checkoutu; obecne zmiany innych prac pozostały poza zakresem.
2. Zarejestrować ownera, bazowy pełny SHA, cel i profil. Nie kopiować `.env` i `node_modules` między checkoutami. Wartości ścieżek hosta pozostają w lokalnym `.env`.
3. Naprawę istniejącego `.fullmag` poprzedzić inwentaryzacją typu reparse pointu/katalogu, targetu, zawartości, aktywnych procesów/mountów i właścicieli. Migracja lub usunięcie danych wymaga właściwej autoryzacji; plan nie jest zgodą na usunięcie współdzielonych danych.
4. Dopiero po zielonym preflight wykonywać build/test/browser w zarządzanym profilu i zapisywać manifest/status w rozwiązywanym storage. Nie stosować „tymczasowego” outputu w checkoutcie w celu obejścia preflightu.
5. Każdy działający, sprawdzony fragment zapisać jako osobny logiczny commit. Integrację całego zadania przeprowadzić zgodnie z aktualną autoryzacją: wymagane testy/review → PR → kontrole → merge → weryfikacja integracji. Ten dokument sam nie uruchamia tego cyklu.

## 3. Etap R0 — Wiarygodna baza i kontrola kwalifikacji

**Zakres:** Q-01, Q-02, Q-03 oraz rozjazd statycznych bramek wydajności. Właściciel: frontend infrastructure, z udziałem właściciela storage. To zależność startowa dla nowych pomiarów, nie warunek dalszego odczytowego projektowania.

**Pliki:** `scripts/fullmag_storage.py` i adaptery tylko jeśli diagnoza wykaże błąd resolvera; `apps/control-room/scripts/{check-api-hygiene,audit-idle-performance,audit-compute-performance}.mjs`; `src/modules/inspector/panels/frequency-domain/ModeCompositionInspectors.tsx`; `src/modules/viewport-3d/viewport3dScalarSurfaceShader.ts`; `.github/workflows/bootstrap.yml` i właściwy wrapper CI po sprawdzeniu jego obecnej treści.

**Działania:**

- Usunąć cztery rzeczywiście zbędne importy. Nie wykonywać przy okazji masowego formatowania.
- Rozdzielić kod produkcyjny od danych fixture’ów w kontroli API, zachowując wykrywanie realnych endpointów poza facade.
- Zastąpić kruche rozpoznawanie wieloliniowych stringów i liczby wystąpień RAF analizą struktury lub małymi testami zachowania. Sprawdzać zakończenie/cancel animacji, nie arbitralną liczbę wywołań w pliku.
- Dodać negatywne kontrole: naruszenie w komponencie, rzeczywista nieskończona pętla, brak teardown, nieprawidłowy proof. Zielony gate musi odrzucać te przypadki.
- Utworzyć jeden indeks evidence dla audytowanego SHA: źródła, config, środowisko, polecenia, exit codes i manifesty. Błędy środowiska, kodu i brak wykonania mają osobne statusy.

**Weryfikacja:** `check:api-hygiene`, `check:architecture-hygiene`, `audit:idle-performance`, `audit:compute-performance`, `typecheck`, `lint`, `test`, `build` z pakietu Control Room, po przejściu managed preflight. Uzupełnić pełny lokalny React Doctor i focused design scan z repozytoryjnej wersji, bez pobierania `@latest`, z outputem w storage. Skan nie jest oceną wizualną ani testem bezpieczeństwa całego produktu.

**Odbiór:** zielone kontrole właściwego SHA, negatywne kontrole faktycznie czerwone, powtarzalny start aplikacji i manifest po zakończeniu. Raport z tsc bez typegen pozostaje diagnostyką pomocniczą. Brak baseline render/memory oznacza `NOT VERIFIED`, nie „0 problemów”.

## 4. Etapy refaktoryzacji

### R1 — Stabilny shell, start i odzyskiwanie

**Pokrycie:** UI-02, UI-03, UI-08, UX-01, UX-02. **Zależność:** źródłowe projektowanie równolegle z R0; odbiór browser po R0. **Właściciel:** workspace/shell.

**Pliki:** `src/kernel/layout/{WorkspaceDockLayout.tsx,layoutModel.ts,WorkspaceShellClient.tsx,SlotHost.tsx,appMenuModel.tsx,shellCommands.ts}`; `src/modules/ribbon/ribbonTabViews.tsx`; `src/design/styles/{layout,header}.css`; wspólne `Resizable`/Dialog, jeśli wymaga tego zachowanie.

**Rezultat:**

- Jedna jawna polityka szerokiego/wąskiego layoutu. Zdefiniować, które panele są docked, a które otwierane na żądanie; menu i Command Palette pozostają dostępne. Automatyczne dopasowanie do okna nie nadpisuje trwale preferencji szerokiego layoutu.
- Stabilny pierwszy render i hydratacja bez montowania kosztownych viewportów w tymczasowym pionowym układzie. Zachować SSR/client zgodność i właściwego właściciela modułu.
- Adapter persistence z catch dla odczytu/zapisu, wersją danych i bezpiecznym defaultem. Jedna komenda Reset layout, także dla zapisanych rozmiarów resizable; snapshot umożliwia cofnięcie.
- Użyteczne minimum Help/About/Diagnostics; module error fallback identyfikuje kontekst, pozwala ponowić lub odtworzyć uszkodzony fragment bez niszczenia całej sesji.

**Testy:** jednostkowe pure layout/persistence policy, render error boundary, browser cold hydration i storage-denied, różne rozmiary z macierzy, reset po reorder/resize/hide. Sprawdzić liczby mount/unmount oraz widoczność komend, nie tylko screenshot statyczny.

**Odbiór:** żadne wspierane działanie nie wymaga poszerzenia okna lub znajomości ukrytego skrótu; storage denial nie wywraca workspace; reset jest kompletny i odwracalny; error w jednym slocie pozostawia pozostałe używalne.

### R2 — Jednoznaczny design system i dostępne kontrolki

**Pokrycie:** UI-01, UI-07, UI-09. **Zależność:** można wdrażać równolegle z R1 po uzgodnieniu własności CSS; finalny odbiór na ustabilizowanym shellu. **Właściciel:** design system/accessibility.

**Pliki:** `src/design/styles/{theme,tokens,base,primitives,tailwind-theme,inspector-frequency-domain}.css`; `app/globals.css`; `src/shared/ui/{Button,Resizable,SegmentedControl,Dialog}.tsx`; `src/modules/ribbon/RibbonMenuRenderer.tsx`; stories i `.storybook`.

**Rezultat:**

- Czytelny token wtórnych informacji, oddzielony od dekoracji i disabled. Ustalić foreground/background każdej roli na panel/raised/hover/selected, zwłaszcza w Latte; przetestować realną kaskadę.
- Jeden właściciel stylu każdego prymitywu. Tailwind, tokeny i klasy `fm-*` mogą współistnieć, ale nie mogą sprzecznie definiować primary/disabled/focus/rozmiarów. Nie usuwać masowo CSS bez analizy konsumentów.
- Nazwane slidery i separatory, wartości z jednostkami, logiczny focus. Hit targety spełniają przyjęte kryteria lub udokumentowany wyjątek; nie wymuszać 44 px na całym desktopie. [W3C Target Size](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html).
- Reprezentatywne stories stanu normal/hover/focus/selected/disabled/pending/error oraz dwóch motywów. Najpierw prymitywy i złożone panele wysokiego ryzyka; liczba stories sama nie jest metryką jakości.
- Ustalić politykę fontów: obecne nazwy Inter/JetBrains Mono dopuszczają fallback systemowy. Jeśli identyczna geometria między hostami jest wymagana, zapewnić jawne ładowanie lokalnych fontów i zweryfikować licencję/subsetting; inaczej testować obsługiwany fallback.

**Testy:** obliczenia kontrastu tokenów plus browser computed style na stanach; keyboard/AX, zoom i reduced motion; wizualne regresje reprezentatywnych kontrolek. Przy korekcie samego koloru nie uruchamiać niepowiązanej kwalifikacji solverów.

**Odbiór:** informacje i wartości pozostają czytelne w obu motywach, disabled/pending nie dimmuje niepowiązanych kontrolek, focus jest widoczny, każda interaktywna kontrolka ma nazwę. Ekrany zgadzają się z deklarowaną hierarchią prymitywów.

### R3 — Explorer i Inspector: przewidywalna praca na danych

**Pokrycie:** UI-04, UI-05, UI-06. **Zależność:** wspólny kontrakt wyboru i zasobów uzgodnić przed zmianami w rendererach. **Właściciel:** authoring/inspection.

**Pliki:** `src/modules/explorer/{ExplorerModule,ExplorerTreeView}.tsx`; `src/modules/inspector/{InspectorShell.tsx,inspectorDescriptor.ts}`; `src/design/styles/inspector.css`; istniejące selection/resource controllers i testy tych powierzchni.

**Rezultat:**

- Refresh ma jednoznaczne znaczenie: odświeża właściwe zasoby i ma stan, a reset filtra/expansion jest osobną akcją, jeśli pozostaje potrzebny.
- Klawiatura działa na logicznym pełnym drzewie; wirtualizacja jest detalem renderera. Home/End oraz szybka nawigacja przewijają i ustawiają focus bez utraty selekcji.
- Inspector ma zwięzły kontekst wybranego celu i rozwijane provenance, w tym snapshot/revision. Uzgodnić treść z istniejącymi podpanelami, zamiast powielać informacje lub odsłaniać cały debug dump.

**Testy:** 500+ węzłów, selekcja poza oknem, grow/shrink/reorder danych; error→Refresh→nowa rewizja; obiekty o równych nazwach; wybrane komórki FDM i FEM; stale snapshot. Jeśli zmianą zostanie dotknięta mutacja, obowiązuje browser regresji Object/Airbox ze stabilnym rootem, focus, scroll i drafts.

**Odbiór:** każda akcja opisuje swój faktyczny skutek, kontekst selekcji jest czytelny, keyboard traversal obejmuje całe drzewo, a panel zachowuje last-good dane ze stosownym oznaczeniem.

### R4 — Czas życia komend i tożsamość sesji

**Pokrycie:** A-01, A-02. **Zależność:** przed większą zmianą pipeline’ów analizy i rendererów. **Właściciel:** kernel/API, przy zachowaniu resource-first contract.

**Pliki:** `src/kernel/commands/{CommandRegistry,commandContext}.ts`; `src/kernel/runtime/studyRuntimeCommandContributions.ts`; `src/kernel/api/ControlRoomApi.ts`; `src/kernel/realtime/RealtimeInvalidationBridge.ts`; `src/kernel/KernelProvider.tsx`; `src/kernel/workspace/{analysisWorkspace,liveChartsWorkspace,quickChartWorkspace}.ts`; współdzielone typy zdarzeń i kontrolerów.

**Kontrakty do ustalenia przed implementacją:**

- Command scope obejmuje jeden identyfikator intencji, deadline i AbortSignal propagowany do odświeżenia precondition, submit i oczekiwania na odpowiedź. Nie mylić przyjęcia komendy z zakończeniem obliczeń solvera.
- Brak ACK po deadline daje stan wymagający rozstrzygnięcia przez istniejący command resource. Abort requestu nie oznacza cofnięcia serwerowej mutacji. Ponowienie wykorzystuje idempotentną intencję; nie powiela operacji.
- Tożsamość sesji/epoch jest jawna w stanie zależnym od serwerowych ID. Odpowiedzi starej generacji nie mogą aktualizować bieżącego wyboru. Layout, theme i inne niesesyjne preferencje pozostają zachowane.
- Wykorzystać istniejący event bus i kontrolery. Jeśli potrzebne jest nowe zdarzenie tożsamości, opisać jego payload, moment emisji i właściciela; nie tworzyć drugiego źródła prawdy obok status/resource facade.

**Testy:** never-settling GET/POST, timeout precondition, spóźniony ACK, command accepted mimo utraty odpowiedzi, cancel tylko po stronie klienta; A→B→A, import stanu, równe ID danych w dwóch sesjach i spóźnione dane z A. Następnie browser UI pending/reconciliation/retry.

**Odbiór:** UI odzyskuje kontrolę w ustalonym czasie, uczciwie pokazuje nieznany wynik i nie dubluje commandów; sesja B nie wykonuje akcji na wyborze z A. Nie wymaga to zmiany fizyki ani obniżenia jakości obrazu.

### R5 — Koszt analizy i wspólny kontrakt wykresów

**Pokrycie:** A-03, A-04. **Zależność:** R4 session scoping; pomiary po R0. **Właściciel:** analysis/performance.

**Pliki:** `src/modules/analysis-plots/useAnalysisPlotsController.ts`; `src/kernel/workspace/analysisWorkspace.ts`; `src/shared/analysis-charts/EChartsCanvasSurface.tsx` i istniejące modele chartów; `src/shared/domain/study/HysteresisChart.tsx`; `src/modules/inspector/panels/{CrossSectionQualityChart,MeshQualityChart}.tsx`.

**Działania:**

- Zmierzyć render reasons i zapisy store dla jednej zmiany selection/resource. Rozdzielić stan użytkownika od modelu wyliczanego z datasetu i rewizji. Nie zastępować wielu subskrypcji jedną szeroką subskrypcją całego store’u.
- Wydzielić czysty model analizy i selektory zwracające stabilną tożsamość przy niezmienionych wejściach. Łączyć powiązane zmiany w transakcję tam, gdzie to usuwa stan przejściowy.
- Ujednolicić spec powierzchni wykresu: quantity, jednostki osi, format tooltipu, legenda, missing/stale/unsupported, keyboard selection, sampling, eksport i lifecycle. Korzystać z istniejących shared analysis-charts.
- Zmierzyć koszt dwóch rendererów dopiero na sekwencji, która faktycznie oba ładuje. Migrację Recharts↔ECharts wykonywać per panel po wykazaniu korzyści; dopuszczalne jest pozostawienie dwóch backendów pod wspólnym kontraktem, jeśli ma to uzasadnienie funkcjonalne.

**Weryfikacja:** focused model/selection tests, `smoke:analysis-plots`, `smoke:analysis-quick-chart`, `smoke:live-charts`, `smoke:results-mode-sweep`, `audit:chart-performance` według dotkniętej ścieżki. Baseline obejmuje liczbę wierszy/serii, kadencję, chunk bytes, first-use latency i retained resources.

**Odbiór:** brak zbędnego effect→store odbicia dla niezmienionych danych, zachowana semantyka wyboru/eksportu, brak idle redraw i brak niejawnego ucinania danych. Opublikowane usprawnienie ma pomiar przed/po; jeśli korzyści nie wykazano, nie przedstawiać samego podziału pliku jako optymalizacji.

### R6 — Wiarygodny obraz 2D/3D i poprawne osie

**Pokrycie:** V-01–V-07. **Właściciel:** visualization/scientific UI. **Kolejność:** R6a i R6b są naprawami P1 i powinny ruszyć bezpośrednio po baseline, przed optymalizacjami R5/R6d. Numer etapu nie oznacza oczekiwania na wszystkie poprzednie etapy.

**R6a — Kolory i occupancy 2D.** Pliki: `src/shared/visualization/scalarColorPalette.ts`; `src/modules/field-map/renderer/{colorRaster,planarColorizer}.ts`; `src/modules/field-map/model/{fieldMapRenderModel,planarOccupancy}.ts`; `FieldMapModule.tsx` i `components/PlanarColorLegend.tsx`.

- Zdefiniować wyraźnie sRGB dla CSS/ImageData oraz linearRGB dla konsumentów Three. Zinwentaryzować wszystkich konsumentów obecnego helpera; nie korygować gamma dwa razy.
- Wprowadzić gotowość spójnej klatki scalar+mask+metadata z tożsamością/rewizją. Wymagana maska missing/error/stale nie może niejawnie oznaczać „cały obszar occupied”. Zachować świadomie wspierane dane bez maski.
- Tests: znane stopy viridis, interpolacja, grayscale, opacity, masked pixels, non-finite, wartość stała, maska opcjonalna/wymagana. Istniejąca asercja `[68,1,84]` nie może zostać „naprawiona” przez przepisanie expected na ciemne bajty bez uzasadnienia kontraktu.
- Browser: identyczny kolor z legendy i rastera dla znanych wartości, poprawne puste obszary i zakres, brak krótkiej fałszywej klatki podczas zmiany rewizji. Wspólny helper wymaga także sprawdzenia konsumenta 3D.

**R6b — Osiowanie i identyfikacja serii.** Pliki: `src/shared/analysis-charts/{InteractiveChartSurface.tsx,chartRenderer.ts}` oraz wspólne modele jednostek i Quick Chart.

- Jedna polityka kompatybilności jednostek na shared boundary. Trzy niezgodne jednostki: jawne ograniczenie selekcji lub osobne powierzchnie; niedopuszczalny fallback na oś 0.
- Zastąpić lookup tooltipu po display label stabilnym `series.id`/`seriesIndex`. Zachować tożsamość również w click/legend/export. Regression check V-07: dwa labele `field`, jednostki `A/m` i `mA/m`, wartości `[1,2]` i `[1000,2000]`; oba tooltipy mają pokazać zgodne wartości fizyczne, także po odwróceniu kolejności serii.
- Tests: 1/2/3+ jednostek, równoważne jednostki z konwersją, niezgodne wymiary, ukrycie serii, duplikaty nazw, point identity i eksport. Browser smoke z rzeczywistymi tooltipami i osiami.

**R6c — Jednolita wiarygodność orientacji CPU/shader.** Pliki: `src/modules/viewport-3d/{viewport3dScalarSurfaceShader,viewport3dFieldMapping}.ts` oraz modele quantity/projection i testy shaderów/kolorów.

- Opisać próg/normę/confidence według rodziny quantity i jednostek przed wdrożeniem; rozwiązanie dla reduced magnetization nie może bezrefleksyjnie zostać zastosowane do H/torque. Zmiana semantyki prezentacji wymaga właściwego spec/notes i mapy symboli.
- Doprowadzić te same wejścia finite/non-finite/zero/low-confidence do tych samych kategorii CPU/shader. Oznaczenie undefined musi być odróżnialne od ważnego kierunku i dostępne w legendzie/diagnostyce.
- Potwierdzić sRGB/linear parity przy różnych renderer output settings. Nie dodawać output chunku do już zakodowanego sRGB bez jawnego wejściowego przekształcenia.
- Tests i browser: normy 0/1e-4/1, NaN/Inf, skalowanie wielkości/jednostek, sample probes; ten sam shade strength i profil wizualny. Wymagane WebGL health oraz pixel/semantic proof.

**R6d — Demand i format glifów po naprawach poprawności.** Pliki: `src/modules/viewport-3d/model/viewport3DFieldDataPlan.ts`; konsumenci `src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts` i `src/modules/viewport-3d/viewport3dResources.ts`; `src/modules/viewport-3d/layers/vectorGlyphGeometry.ts` i producenci buforów.

- Zbudować tabelę: scalar surface x/y/z/magnitude, orientation, glyphs, kilka współdzielących warstw, visible/hidden, cold/warm. Każda pozycja ma wymagany component/scope/carrier i zasady reuse.
- Zachować rozdział stabilnej topologii od payloadu/projekcji pola. Obecny pełny carrier świadomie stabilizuje widoczne pole przy zmianie projekcji. Preferować mniejszy payload tylko wtedy, gdy pomiar wykaże korzyść bez migotania, dodatkowych requestów lub reuploadów. Dopuszczalnym wynikiem V-05 jest uzasadnione pozostawienie obecnego reuse.
- Zastąpić rozpoznawanie stride z podzielności długości jawnym formatem bufora. Jeśli legacy 6-float jest nieużywane, usunąć obsługę dopiero po sprawdzeniu producentów i kompatybilności; jeśli wspierane, walidować format, długość i count.
- Tests: równoważność obrazu i selekcji, konflikty wymagań warstw, prawidłowe 6/7-float i długość 42, uszkodzony payload. Performance: bytes, decode, uploads, frame time i retained memory przed/po, bez zmniejszania gęstości glifów.

**Odbiór R6:** wszystkie pokazane wartości zachowują semantykę quantity/units/mask i powiązanie z artefaktem, kolor legendy odpowiada mapie, niezgodne jednostki nie są mieszane, format bufora jest jednoznaczny. Bieżący compiler pass nie zastępuje tych dowodów.

### R7 — Kwalifikacja produktu i zamknięcie integracji

**Pokrycie:** wszystkie findings i brakujące dowody. **Zależność:** zakończone właściwe naprawy; nie trzeba blokować każdego małego PR na niepowiązanych scenariuszach.

Uruchomić macierz poniżej na końcowym SHA i świeżym buildzie produkcyjnym, wykorzystując istniejące smoke/audit skrypty. Uzupełnić brakujące przypadki zamiast tworzyć konkurencyjny katalog dowodów. Oddzielić fixture validation od realnego session-backed FDM/FEM. Zarchiwizować wynik review, manifest, source/input identity, browser/theme/viewport, statusy i ścieżki artefaktów w jednym indeksie.

Odbiór produktu obejmuje praktyczne przejście create/open→edit→mesh→run→results→export oraz recovery, nie tylko zestaw izolowanych zielonych testów. Jeżeli formalne naukowe/GPU lanes pozostają niewykonane, jawnie ograniczyć deklarację wydania; nie relabelować ich jako PASS dzięki działającemu canvasowi.

## 5. Macierz kwalifikacji produktu

Macierz jest wymaganym rezultatem końcowego etapu. Każdy rekord zawiera scenariusz, źródłowy SHA, tryb dev/production, przeglądarkę, rozmiar okna, theme, dane wejściowe, requested/resolved execution, wynik i ścieżkę do artefaktów. Fixture’y i sesje solvera mają oddzielne rekordy.

| Obszar | Scenariusze minimalne | Dowód odbioru |
|---|---|---|
| Pierwsze uruchomienie | Brak sesji; API odmawia; API nie odpowiada; sesja uszkodzona; ponowienie | Zrozumiały stan i skuteczna akcja naprawcza, brak nieskończonego loading; brak utraty istniejącej sesji |
| Authoring | Utworzenie FDM/FEM, geometria, materiał, fizyka, mesh, etap, zapis/odczyt | Tożsamość obiektu i aktywnego celu poprawna, walidacja przed command, błąd przy polu |
| Inspector | Object/Airbox: zmiana pola podczas pending/ACK, invalidation i reselekcji | Ten sam root, focus, scroll, drafts; brak dimming/disabled niezwiązanych kontrolek, brak opacity animation, ograniczone request/render counts |
| Layout | 1920×1080, 1440×900, 1280×720, 1024×768; pomocniczo 768×1024 i 390×844 | Desktop zachowuje użyteczny viewport; wąski ekran zapewnia dostęp do paneli i recovery, brak utraty przycisków; oba motywy |
| Dostępność | Keyboard-only, zoom 200%, powiększenie i reflow formularzy, reduced motion | Logic focus order, nazwane kontrolki, widoczny focus, zamknięcie modali i powrót fokusu; kontrast i hit targety |
| 3D | FDM/FEM; object/airbox; surface/wireframe/points/vectors; kilka obiektów; clipping i projection | Widoczny canvas, `gl.isContextLost() === false`, niezerowy drawing buffer, poprawna legenda/zakres/jednostka, semantyka selekcji |
| Airbox/FDM vectors | Oddzielne kroki wireframe on → off → vectors on | Ostatnia klatka bez wireframe, niezerowe czytelne glify, brak zagęszczenia zasłaniającego trajektorię; długość niezależna od kamery |
| 2D | Plane/slice/profile, zmiana ilości/komponentu, wartości stałe i niefinitywne | Spójność mapy, skali, odczytu i eksportu; fizyczne współrzędne i jednostki |
| Charts/results | Pusta seria, jedna próbka, duży zbiór, mixed units, zmiana artefaktu, live, export | Brak fałszywych osi i niejawnego ucinania; wybór punktu odpowiada danym, eksport zachowuje semantykę |
| Recovery | Zerwanie/reconnect, stale field, brak carrier, niezgodna rewizja, command rejection | Czytelna różnica missing/stale/unsupported/error, last-good oznaczone, brak przedstawienia starych danych jako aktualnych |
| Lifecycle | Wielokrotne mount/unmount i zmiana 3D/2D/Results; ukryta karta; context loss/restore | Brak narastających listenerów/workerów/zasobów; kontrolowane teardown i odtworzenie |
| Release | Production web oraz docelowy desktop/WebView | Workflow bez dev-only obejść, smoke na artefakcie wydania, bieżące wymagane kontrole CI |

Wąskie okna są testem odporności, nie automatycznym zobowiązaniem do pełnego authoringu na telefonie. Specyficzny zakres wsparcia urządzeń powinien być jawny. Wyjątek reflow dla wykresów/3D nie dotyczy całej aplikacji. [W3C Reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html).

### Zestawy danych i pomiary

- Reprezentatywne małe/średnie/duże dane dla FDM i FEM: zapisać liczbę aktywnych komórek/węzłów, faces/edges, glifów, bajtów pól, punktów/serii wykresu i kadencję update. Kategorie nie mogą być tylko nazwami „small/large”.
- Dla każdego hot path: cold load, warm reuse, idle po ustabilizowaniu i aktywna interakcja. Co najmniej trzy powtórzenia porównawcze przy tych samych wejściach i ustawieniach; oddzielić narzut dev od production.
- Mierzyć p50/p95 interakcji, long tasks, czas dekodowania/modelu, liczbę requestów i transfer, uploads topologii/buforów, render reasons oraz liczby żywych zasobów. Nie zastępować tego liczbą `useMemo`.
- Chart idle: wymaganie braku nieuzasadnionych redraw/requestów zachować z istniejącego audytu. Budżety czasowe i pamięci dla obciążeń wyznaczyć na baseline oraz istniejących kontraktach. Proponowany cel warm interakcji do 100 ms wymaga jawnego przyjęcia po baseline; nie jest wynikiem tego audytu.
- Leak claims: wykonać bounded stress loop; dla chartów zacząć od istniejącego `audit:chart-performance` i jego konfiguracji, zamiast tworzyć drugi konkurencyjny harness. Raportować plateau oraz retained counts/bytes z tolerancją szumu. Brak globalnego GC w danej przeglądarce opisać, nie maskować.
- Porównać jakość obrazu przed i po na identycznym workload: nie zmniejszać domyślnej liczby glifów, jakości topologii lub warstw, aby uzyskać lepszy czas. Fallback jakości musi być jawny, opcjonalny i uzasadniony.

## 6. Kolejność, ryzyka i definicja zakończenia

### Powiązanie z audytem

| Ustalenia | Etap odpowiedzialny | Najważniejszy dowód |
|---|---|---|
| Q-01, Q-02, Q-04 | R0 | Zielone kontrole i negatywne przypadki, odporność LF/CRLF |
| Q-03 | R0, osobna diagnoza środowiska | Inwentaryzacja, legalna korekta środowiska i zielony managed preflight |
| UI-02, UI-03, UI-08, UX-01, UX-02 | R1 | Cold load, wąskie okno, storage denial i recovery w przeglądarce |
| UI-01, UI-07, UI-09 | R2 | Kontrast i computed style, nazwy w AX, oba motywy |
| UI-04, UI-05, UI-06 | R3 | Refetch po błędzie, duże drzewo, czytelny kontekst Inspectora |
| A-01, A-02 | R4 | Niepewny ACK bez duplikatu i izolacja dwóch sesji |
| A-03, A-04 | R5 | Pomiary renderów, first-use i pamięci przy równoważnym zachowaniu |
| V-01, V-02 | R6a | Znane kolory, zgodność legendy, kompletność scalar+mask |
| V-04, V-07 | R6b | Poprawna walidacja 1/2/3+ jednostek i skala tooltipu niezależna od nazwy |
| V-03 | R6c | Ten sam kontrakt confidence dla CPU/shadera i różnych quantity |
| V-05, V-06 | R6d | Bilans pełnego carriera i jednoznaczność wspieranego formatu |
| Wszystkie oraz brakujące lanes | R7 | Aktualna macierz produktu, review i kwalifikacja deklarowanych realizacji |

### Kolejność realizacji i podział zmian

1. **Ustanowić baseline:** R0. Diagnoza storage jest odrębnym torem; małe poprawki źródeł i projektowanie mogą postępować równolegle, ale nie zastępują zielonego preflightu.
2. **Usunąć P1:** R6a i R6b oraz kontrast z R2 i dostęp do nawigacji z R1. Zmiany koloru rastera oraz przypisania osi to oddzielne logiczne fragmenty. Nie wiązać ich z wymianą rendererów.
3. **Domknąć niezawodność:** pozostałe R1/R2, R3 oraz R4. Prace nad layoutem/CSS mają uzgodnionego właściciela wspólnych plików. R4 poprzedza zmianę zakresu stanu w R5.
4. **Ujednolicić semantykę i optymalizować:** R6c, następnie pomiary i uzasadnione zmiany R5/R6d. Pomiary wymagają sprawnego środowiska, a V-05 może zakończyć się bez zmiany kodu.
5. **Zakwalifikować całość:** R7 na końcowym buildzie, zachowując ważne dowody fragmentów, jeśli nie zmieniły się ich źródła, wejścia i warunki.

Każdy commit/PR ma jeden czytelny rezultat, wykaz dotkniętych kontraktów i adekwatne testy. Rozdzielić czyszczenie importów, naprawę skanerów, zmianę layoutu, korektę kolorów, osi i stanu sesji. Zmiany zależne, które oddzielnie łamią kontrakt lub build, integrować razem. Nie przyjmować jednego wielkiego „frontend rewrite” jako jednostki odbioru.

### Ryzyka wykonania

| Ryzyko | Ograniczenie ryzyka |
|---|---|
| Dirty checkout i równoległe prace zmienią baseline | Izolacja, zapis pełnego SHA i ponowna ocena tylko zmienionych ustaleń |
| Naprawa wspólnej palety poprawi 2D, lecz pogorszy 3D | Jawne granice sRGB/linear i test wszystkich konsumentów przed integracją |
| Mniejszy payload wydłuży zmianę projekcji | Porównać cold/warm i współdzielenie warstw; pozostawić pełny reuse, jeśli korzystniejszy |
| Timeout spowoduje podwójne polecenie | Stan niepewnego wyniku, reconciliation i zachowane `client_intent_id` |
| Reset sesji usunie preferencje globalne | Rozdzielić zakresy danych; test A→B z zachowaniem theme/layout |
| Zmiana CSS ukryje regresje gęstych paneli | Małe zmiany roli/stanu, oba motywy i reprezentatywne sceny zamiast globalnego restylingu |
| Dostosowanie skanera zamaskuje realną regresję | Każda zmiana bramki ma negatywną kontrolę i nie zastępuje pomiarów runtime |
| Niedostępny GPU/runtime ograniczy odbiór | Jawny NOT VERIFIED dla brakującej realizacji; bez rozszerzania deklaracji produktu |

Dokładnego kalendarza nie wyznaczono: zależy od przywrócenia środowiska i wyników baseline. Po R0 należy oszacować konkretne pakiety na podstawie faktycznego zakresu i dostępnych właścicieli; nie deklarować oszczędności czasu ani pamięci przed pomiarem.

Warunki ukończenia całej refaktoryzacji:

1. Każde ustalenie audytu ma status: naprawione z dowodem, odrzucone z kontrdowodem albo jawnie odłożone z właścicielem i ograniczeniem produktu. Wymagana bramka nie może zostać zamknięta przez samo odłożenie.
2. Wymagane typecheck/lint/test/build i właściwe kontrole API/architektury przechodzą. Nie włączać StrictMode przy obecnym R3F bez osobnego aktualnego browser proofu.
3. Oba motywy i macierz UI mają aktualne artefakty; dostępność sprawdzono automatycznie i ręcznie. Stan disabled, focus, pending, error i selected jest spójny.
4. Każda zmiana viewportu ma proof WebGL; każda zmiana mutacji Inspectora ma proof stabilności Object/Airbox, o ile dany obiekt wspiera mutację.
5. Każde twierdzenie o przyspieszeniu lub redukcji pamięci ma baseline i pomiar po zmianie na tych samych danych; semantyka i domyślna jakość pozostają zachowane.
6. Dla deklarowanych ścieżek FDM CPU/GPU i FEM CPU/GPU istnieją osobne rekordy sesji → artefakt → UI. Brak runtime/GPU receipt nie jest zastępowany fixture’em.
7. Przejrzano diff i dowody, wykonano obowiązujące review i cykl integracji. Współdzielone pliki/cache i cudze worktree pozostają nienaruszone; blokady integracji są zapisane z następnym krokiem.

Załączniki źródłowe i dokładne wyniki audytu: [frontend-general-audit.md](../../reports/2026-09-12/frontend-general-audit.md). Brakujące dziś runtime/browser/physics lanes pozostają **NOT VERIFIED** do czasu dostarczenia adekwatnych dowodów.

## 7. Dziennik realizacji — 12.09.2026

Ponownie ustalono bazę: lokalny `master` to `5084a94ed14b151fc865e8def5a5c28401e98b44`; główny checkout zawiera niezależne dirty zmiany i nie był modyfikowany. Implementację wykonano w `C:\git\fullmag\worktrees\frontend-refactoring-20260912` na branchu `codex/frontend-refactoring-20260912`, z profilem storage `frontend-refactoring-20260912-6779243652b71ac6` i zapisanym ownerem zadania. Ostatni ukończony etap kodowy to `43e7a64d2a2b10e82280a32d367579a5d9c7774c`; ten dziennik jest późniejszym commitem dokumentacyjnym, a poszczególne logiczne etapy są zapisane osobnymi commitami.

| Fragment | Wdrożony zakres | Dowód i status |
|---|---|---|
| R0 / storage | Wydzielona, walidowana lekka ścieżka `frontend-install`, `frontend-check`, `frontend-dev`; nie przechwytuje buildów/smoke spoza allowlisty; status zapisuje operację i klasę wykonania; parser `audit-compute-performance` normalizuje LF/CRLF | `python -B scripts/test_fullmag_storage.py`: 28 testów, 2 pominięte — **PASS**; `just_storage_shell.sh` przechodzi `bash -n`; `node scripts/audit-compute-performance.mjs` i `node scripts/audit-idle-performance.mjs` — **PASS**; managed runner/preflight pełnego środowiska — **NOT VERIFIED** |
| R1 | Odmowa storage nie wywraca odtwarzania layoutu; pierwszy render używa placeholderów bez montowania ciężkich modułów; fallback slotu pokazuje kontekst, szczegóły techniczne i retry z ponownym importem; uchwyt docka ma nazwę; Help/Reference/About/Diagnostics działają przez wspólną powierzchnię; Reset layout przywraca stan, usuwa kolejność i wszystkie rozmiary docka oraz remountuje grupę | Testy źródłowe dodane/aktualizowane; browser cold hydration, storage-denied, utility dialogs i error recovery — **NOT VERIFIED** |
| R2 | Skorygowano tokeny kontrastu, konflikt właścicieli stylu `Button`, wąski header z menu kompaktowym, nazwy slidera i wartości z jednostką | Testy kontraktów CSS/AX są w diffie; computed style/AX w przeglądarce — **NOT VERIFIED** |
| R3 | Refresh Explorer odświeża aktywne zasoby z deduplikacją i stanem error/loading; wirtualizowane drzewo nawiguje po pełnej liście; kontekst Inspectora jest rozwijany i nie ucina wartości | Testy helpera, drzewa i CSS dodane; browser refetch/focus/selection — **NOT VERIFIED** |
| R6a | Wymagana maska occupancy blokuje raster i zakres do gotowej, zgodnej klatki scalar+mask; błąd/stale pozostaje widoczny | Testy modelu maski dodane; WebGL/pixel parity i runtime revisions — **NOT VERIFIED** |
| R6b | Jednostki kompatybilne są konwertowane do wspólnej osi; ponad dwa niezgodne wymiary kończą się `unsupported`; tooltip rozwiązuje serię po `seriesIndex` z fallbackiem etykiety | Testy modelu/rendererów dodane; rzeczywisty tooltip/eksport w browserze — **NOT VERIFIED** |
| R4 / A-02 | Analiza, Live Charts i Quick Chart czyszczą stan zależny od danych przy zmianie kompletnej tożsamości `session_id + session_epoch`; reset nie dotyka preferencji layoutu/theme | Testy trzech store’ów i kontrakt `KernelProvider` dodane; browser A→B→A oraz spóźnione odpowiedzi — **NOT VERIFIED** |
| R6d / V-06 | Format bufora glifów jest jawny: produkcyjne źródła przekazują `segmentStride=7`, wspierany legacy używa `6`; długość, count i przekazanie przez worker są walidowane, a stride jest częścią klucza cache | Kontrole statyczne i diff — **PASS**; testy Vitest, worker/browser/WebGL — **NOT VERIFIED** |
| R4 / A-01 — granica requestu | Wspólny deadline i `AbortSignal` obejmują odświeżenie precondition oraz submit dla komend study runtime; `CommandRegistry` kończy zawieszony request wynikiem `reconciliationRequired`, a `ControlRoomApi` propaguje `Idempotency-Key` z `client_intent_id`. Specyfikacja cyklu komend została uzupełniona | Commit `43e7a64d2`; kontrole statyczne — **PASS**; testy Vitest i browser pending/reconciliation — **NOT VERIFIED** |
| R4 / A-01 — UI i mutacje mesh; R5; R6c; R6d / V-05; R7 | Nie wdrożono jeszcze powierzchni UI do rozstrzygania nieznanego wyniku i ponowienia tej samej intencji, integracji z istniejącym command resource ani objęcia ścieżki authoring mesh stabilnym intentem. Nie zmieniano modelu stanu pochodnego, progów orientacji CPU/shader, bilansu carriera ani kwalifikacji wydania bez wymaganych kontraktów i pomiarów | Pozostają otwarte z macierzy; nie przedstawiać jako ukończone |

### Źródłowa macierz zapotrzebowania R6d

Poniższa macierz wynika z `buildViewport3DPassDemands`,
`planViewport3DFieldResourceRequests` oraz konsumentów `VectorFieldLayer`. Jest
kontraktem źródłowym, nie pomiarem liczby requestów ani kosztu pamięci. `cold`
oznacza pierwszy request dla danej kombinacji quantity/scope/replay, a `warm`
oznacza możliwość reuse po tym samym `requestId` i rewizji zasobu.

| Konsument / stan | component w żądaniu | scope_kind / scope_id | carrier i kompletność | cold / warm |
|---|---|---|---|---|
| Primary surface, shader widoczny, projekcja x/y/z/magnitude/orientation | `full` (stabilny carrier projekcji) | `full` / brak | pełny carrier, `complete` | request zasobu / reuse po rewizji |
| Primary vector glyphs widoczne | `full` | `full` / brak | pełny carrier, `complete` | request zasobu / reuse po rewizji |
| Part surface, shader widoczny | `full` | `part` / `part.id` | pełny carrier części, `complete` | request scoped / reuse po rewizji |
| Part vector glyphs widoczne, shader ukryty | `full` | `part` / `part.id` | pełny carrier części, `sampled-ok`, `max_samples=budget` | sampled request / reuse po rewizji |
| Part surface + glyphs dla tego samego quantity/scope | `full` po merge | `part` / `part.id` | jeden carrier, `complete` | jeden request / reuse po rewizji |
| FDM Airbox glyphs | `full` | `airbox` / część Airbox | pełny carrier Airbox, `sampled-ok`; limit budżetu może być oversamplowany ×8 | sampled request / reuse po rewizji |
| FDM native layer widoczny (shader lub vectors) | `full` | `layer` / `layerId` | pełny carrier warstwy, `max_samples` z planu | layer request / reuse po rewizji |
| Colorbar x/y/z/magnitude | wybrany komponent | scope celu | `complete`; przy wspólnym carrierze merge może podnieść żądanie do `full` | request/merge / reuse po rewizji |
| Target hidden albo brak aktywnej warstwy | brak | brak | brak requestu | brak / brak |

Wspólny klucz merge nie łączy różnych `scope_kind`/`scope_id` ani różnych
replay query. Pełny carrier pozostaje decyzją stabilności projekcji; jego koszt
(`bytes`, requesty, decode, upload, retained memory i warm switch) wymaga
osobnego pomiaru V‑05 przed ewentualną zmianą.

W `parsePinnedQuickChart` deduplikacja wybranych serii używa zbioru o stałym czasie sprawdzenia; zachowanie kolejności i limitu pozostaje bez zmian. Nie przedstawiam tego jako zmierzonej poprawy całego UI bez baseline R5.

Po ostatnim commicie `43e7a64d2` ponowiono kontrole źródłowe: `python -B scripts/test_fullmag_storage.py` — 28 testów, 2 pominięte, **PASS**; `node scripts/check-architecture-hygiene.mjs`, `node scripts/check-api-hygiene.mjs`, `node scripts/audit-compute-performance.mjs`, `node scripts/audit-idle-performance.mjs` oraz `git diff --check 5084a94ed14b151fc865e8def5a5c28401e98b44..HEAD` — **PASS**. Staged React Doctor przeskanował 11 plików i zgłosił dwa istniejące ostrzeżenia `await inside a loop` w `ControlRoomApi.ts:3056` i `:3089`; oba pochodzą ze starszych commitów i nie zostały wyciszone. Próba `bash -n scripts/just_storage_shell.sh` na tym hoście została odrzucona przez usługę Bash (`E_ACCESSEDENIED`); wcześniejszy przebieg tej kontroli zapisano przy R0.

Diagnostyczne uruchomienie Vitest ze źródłami worktree nie było możliwe: `pnpm --dir apps/control-room test -- ...` kończy się brakiem wykonywalnego `vitest`, a próba `pnpm install --offline --frozen-lockfile --ignore-scripts` zatrzymuje się na `ENOTDIR` dla zarządzanego junctionu `node_modules`; wcześniejszy dostęp do tego junctionu i instalacja offline były odrzucane przez host (`EPERM`). `pnpm --dir apps/control-room typecheck` kończy się `MODULE_NOT_FOUND` dla `next/dist/bin/next`, a `pnpm --dir apps/control-room lint` brakiem wykonywalnego `eslint`. `just runner-container-status` kończy się kodem 1 na preflightzie `Container profile allow-list mismatch`: kod worktree deklaruje trzy profile, a hostowy rekord koordynatora zawiera dodatkowo dwa profile `*-current-contracts-v1`; konfiguracji hosta nie zmieniano. Nie obchodzono tej granicy. Dlatego testy TypeScript, Vitest, lint, build, browser/WebGL, nauka i release nadal mają status **NOT VERIFIED**. Raport audytu pozostaje źródłem historycznych findings; ten dziennik opisuje stan bieżącej implementacji.

Publikacja brancha, utworzenie PR i merge są obecnie **BLOCKED**: automatyczny review odrzucił `git push` jako publikację zewnętrzną, interpretując pierwotny zakres jako audyt/plan. Lokalny branch i worktree pozostają czyste, a logiczne commity są gotowe do przeglądu. Po jednoznacznej autoryzacji publikacji należy wypchnąć `codex/frontend-refactoring-20260912`, otworzyć PR do `master`, przejść wymagane kontrole, a dopiero potem wykonać integrację i końcową weryfikację.
