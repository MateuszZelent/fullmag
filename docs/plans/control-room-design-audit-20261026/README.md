# Wdrożenie audytu Control Room — 26.10.2026

## Kontrakt

Właściciel: Codex, chat `01a17778-b57b-7e63-9d36-962088bb6e66`.
Autoryzacja: użytkownik zlecił wdrożenie wszystkich poprawek zgodnych ze zweryfikowanym audytem.
Kierunek B: ewolucja istniejącego workspace i Catppuccin. Odłożone rekomendacje pozostają odłożone, chyba że przegląd wykaże konkretny błąd w zakresie zadania.

- Branch: `codex/control-room-design-audit-20261026`.
- Baza: `1afcb531630d6cd5b8caba1f8a4d4593bb29cdb7`.
- Worktree: `/home/kkingstoun/git/fullmag/worktrees/control-room-design-audit-20261026`.
- Rejestr: `control-room-design-audit-202610-5c06984829cdd0e9`.
- Compose: `fullmag-worktree-control-room-design-audit-202610-5c06984829cdd0e9`, planowany port 3230.
- Źródło audytu: `C:\Users\Mateusz\Documents\ChatGPT\Fullmag\design-audit-2026-10-26`; hashe tekstów w [manifest.json](manifest.json).
- [Postęp i dowody](progress.md). Status planu nie dowodzi wykonania.

## Rozstrzygnięcia D1–D10

| ID | Przyjęte rozstrzygnięcie |
|---|---|
| D1 | Osobny pasek instancji tylko w hoście; Home dostępne także w menu iframe. |
| D2 | Czytelne neutralne teksty i semantyczne znaczniki; zwykły tekst co najmniej 4.5:1, istotne wskaźniki 3:1. Palety naukowe bez zmian. |
| D3 | Prymitywy fm CSS zarządzają wyglądem; CVA wybiera klasy. Bez globalnej zmiany kolejności kaskady. |
| D4 | Ukryte niezaimplementowane preview; zarejestrowane czasowo niedostępne komendy zachowują powód. |
| D5 | Globalny transport i kontekst Study korzystają z tych samych command ID; menu, paleta i skróty pozostają. CTA empty-state dozwolone. |
| D6 | Lokalne Inter/JetBrains Mono z licencjami; light/dark/system i poprawny prepaint. |
| D7 | Full domyślne, compact/collapsed zapamiętane; min. 24 px hit area, docelowo 28–32 px. |
| D8 | Wspólna rama paneli, odrębny uchwyt, obsługa klawiatury; hide/minimize/float/restore zachowują draft i nie zatrzymują solvera. |
| D9 | Porządek nakładek bez zmiany domyślnych wymiarów, danych, jakości renderera i jawnego companion viewport. |
| D10 | Macierz stanów poniżej; stany syntetyczne oznaczane osobno od rzeczywistego runtime. |

## Rekomendacje


Status: **zachować** = kierunek uzasadniony, **doprecyzować** = nie wdrażać literalnie, **odłożyć** = poza minimalnym zakresem. P1 oznacza funkcjonalność/czytelność, P2 systematyzację, P3 kosmetykę. Zależność od fundamentu nie czyni zadania P0. Błąd uniemożliwiający wykonanie podstawowej czynności może uzyskać P0 po reprodukcji.

| R | Ocena | Korekta / kryterium |
|---|---|---|
| 1 | zachować, P1 | usuwać konflikt dla jednego prymitywu naraz; computed style w prawdziwym ekranie |
| 2 | doprecyzować, P2 | parity kluczy semantycznych; wspólne fallbacki dopuszczalne, nie każdy token musi być powtórzony |
| 3 | zachować, P1 | role treści vs disabled; mierzyć faktyczne pary tło/tekst, także hover/selected |
| 4 | zachować, P1 | poprawić theme selector i przenieść barwy grup do kategorii |
| 5 | podzielić, P1/P2 | font asset/licencja/offline; osobno first paint; osobno preferencja System |
| 6 | doprecyzować, P1 | wspólna prezentacja domenowych statusów, nie jedna redukcja do Ready |
| 7 | zachować, P2 | aliasy usuwać po migracji wszystkich konsumentów; category ≠ status |
| 8 | doprecyzować, P2 | skale domyślne i uzasadnione wyjątki; nie zakaz wszystkich literałów/layout breakpoints |
| 9 | odłożyć, P3 | usunąć tylko udowodnione martwe zależności, także stories/testy/manifesty |
| 10 | zachować, P2 | określić locale UI i niezależny kanoniczny zapis danych naukowych/eksportu |
| 11 | doprecyzować, P2 | tab close hit area ≥24; keyboard close; brak zmiany modelu wielu instancji |
| 12 | zachować, P1 | wspólny header; grid nie może wypchnąć menu/transportu |
| 13 | doprecyzować, P1 | wspólny kontener z osobnymi execution/readiness; connection jako osobna oś |
| 14 | zachować, P1 | właściwe data attributes; akcje wynikają ze stanu i capability; bez podwójnego Pause |
| 15 | zmienić, P1 | Home dostępne także w iframe; Apply zachowane dla wszystkich edytowalnych targetów i skrótów |
| 16 | zachować, P1 | menu zastępcze; próg według realnej szerokości treści |
| 17 | odłożyć, P3 | logo bez przypadkowego zoomu, o ile funkcja nie jest potrzebna; oddzielna decyzja |
| 18 | zachować, P2 | hierarchia rozmiarów, ale 22 px nie jest bezwarunkowym celem dla klikalnych elementów |
| 19 | doprecyzować, P1 | toolbar dla odpowiednich grup; nie odbierać strzałek selectom i polom numerycznym |
| 20 | zachować, P1 | overflow zachowuje ID, gating, tooltip i klawiaturę |
| 21 | zachować, P2 | tryb zapamiętany; Ctrl+F1 po kontroli konfliktów skrótów |
| 22 | doprecyzować, P2 | porównać ID i parametry; zachować Rotation mode i Camera settings oraz Remove selected stage; echo tej samej komendy bywa pożądane |
| 23 | zachować warunkowo, P2 | odróżnić placeholder od chwilowego disabled; preview ma właściciela |
| 24 | podnieść do P1 | submitted/ACK ≠ completed; jeden foreground failure i historia |
| 25 | zachować, P1 | glosariusz i skróty z rejestru; mojibake sprawdzić w źródle i UI |
| 26 | odłożyć, P3 | dekompozycja po odpowiedzialnościach; 4021 linii samo nie uzasadnia architektury |
| 27 | zachować, P2 | wspólna rama, odrębny drag handle i alternatywa klawiaturowa |
| 28 | zmienić, P1 | wspólna stylistyka Tabs; segmented/radio i toggle nie są tym samym prymitywem semantycznym |
| 29 | zachować, P1 | czytelne meta; odtworzyć Expand/Collapse/Refresh i Diagnostics po przeniesieniu |
| 30 | podzielić, P2 | porządek nakładek tak; domyślne wyłączenie wymiarów i nowa skala długości wymagają osobnej decyzji |
| 31 | zachować, P1 | scoped identity + draft/pending/ACK/conflict; nie jednolity Apply dla read-only |
| 32 | zachować, P2 | akcje per karta; zachować dotychczasowe operacje i diagnostykę |
| 33 | zachować, P1 | jednostki i brak obcięć; brak próbki to „—”, nie zero; CTA ocenić kontekstowo |
| 34 | doprecyzować, P1 | requested/resolved, connection, freshness; nie kasować jedynego wyjaśnienia błędu |
| 35 | zachować, P2 | wspólne formy empty/error; treść i domena pozostają różne |
| 36 | odłożyć, P3 | problem deweloperski; nie mieszać z produkcyjnym kryterium designu |
| 37 | zachować, P2 | Home obejmuje loading/empty/selected/error; jawne FDM/FEM i import/script behavior |
| 38 | zachować, P2 | szczegóły po zaznaczeniu; pełny host ID na żądanie, bez utraty informacji |
| 39 | zachować, P2 | most do wspólnych tokenów; najpierw sprawdzić potrzebne wyjątki Home |
| 40 | doprecyzować, P1 | guards kontraktów i par kolorów; nie testy liczące arbitralnie linie/literały |
| 41 | rozszerzyć, P1 | równe viewport/DPR/zoom; 900 px, 200%, iframe, draft, stale, offline; nie tylko happy path |
| 42 | zachować, P2 | zmienić właściwe spec; ADR tylko dla trwałej decyzji architektury, nie dla każdej liczby px |


## Etapy i dowody

Numer komunikatu to numer etapu T + 1, spośród 13 etapów.

| Etap | Pliki / odpowiedzialność | Zależność | Kryteria odbioru i adekwatne dowody |
|---|---|---|---|
| T0. Baseline i decyzje | spec 09/10/12/33, ADR0016/0069, fixtures/metryki | brak | zaakceptowane D1–D10; nagrania stanów i manifest runtime/viewport; katalog command ID |
| T1. Button i kontrast | `design/styles/{base,theme,primitives}.css`, `shared/ui/Button.tsx` | T0 | brak sprzecznej kaskady; primary/disabled/focus w obu motywach; kontrast realnych par |
| T2. Typografia i start theme | `app/layout.tsx`, `design/theme/ThemeProvider.tsx`, font assets, tokens | T0 | wybrany font działa offline i ma licencję; pierwsza klatka zgodna z preferencją; brak hydration warning |
| T3. Tabs i kontrole wartości | `shared/ui/Tabs.tsx`, style tabs, pierwsza migracja panelu | T1 | brak globalnego 44 px; poprawne tabs/radio/toggle; klawiatura i focus |
| T4. Header i instance strip | `kernel/layout/AppMenuBar*`, `InstanceTabStrip`, style header/instance-tabs | T1–T3 | żadnej utraty Home w iframe, menu na 900 px, Stop podczas runu, brak overlap close |
| T5. Jeden ribbon — Workspace/Study | ribbon renderer i contribution tych kart | T4 | command migration matrix bez utraty funkcji, zgodny glosariusz, overflow + keyboard |
| T6. Pozostałe karty ribbonu | po jednej rodzinie contribution + renderer galleries/split | T5 | ID/gating/feedback zachowane; wszystkie karty z §3 ocenione; preview oddzielone od disabled |
| T7. PanelFrame i Explorer | layout/WorkspaceDockLayout + Explorer + odpowiednie style | T3 | jeden nagłówek; drag/resize/keyboard; pełne meta, filtre, Diagnostics; przywrócenie layoutu |
| T8. Inspector identity i akcje | InspectorShell, IdentityFrame, Object/Airbox, property primitives | T7 | jeden tytuł; read-only poprawny; draft/pending/ACK/conflict; stabilność Object i Airbox |
| T9. Viewport chrome | ViewportTabHost, DOM overlays, viewport styles | T7 | czytelna scena obu theme; bez zmiany danych/jakości; widoczny canvas, context nieutracony, buffer >0 |
| T10. Dock i provenance | Footer/Telemetry/StatusBar i style | T7 | jednostki, brak obcięć, missing≠zero, osobne osie statusu i requested/resolved |
| T11. Home i dialogi | modules/start + style start/dialog | T2–T3 | empty/selected/loading/error; brak pustej prawej kolumny; zachowana ścieżka FDM/FEM/skrypt/import |
| T12. Integracja i porządki | guards, zrzuty, dokumentacja, potwierdzone dead code | T4–T11 | macierz odbioru kompletna; żaden cleanup nie usuwa komendy lub stanu |


## Bramka weryfikacji

Wszystkie buildy lokalne wyłącznie we własnej grupie Compose. Użytkownik dla tego wdrożenia jawnie dopuścił testy frontendu/Vitest oraz obowiązkowe automatyczne testy CI, także Rust/C++. Pozostały zakaz lokalnego kompilowania natywnych testów jednostkowych nadal obowiązuje. Interpretowane kontrole źródeł, typecheck/lint aplikacji i browser checks mają odrębny zakres. Brakującej bramki nie oznaczamy jako PASS.
Nie uruchamiamy Solve przy inspekcji UI. Nie utożsamiamy działającego Home z kwalifikacją FDM/FEM CPU/GPU.

## Macierz odbioru


- [ ] Light/dark; 1920/1440/1180/900 px; jawne DPR, zoom, fonty, SHA i profil runtime.
- [ ] Home bez sesji, empty recents, selected item, unavailable script/import, powrót do działającej sesji.
- [ ] Workspace read-only, edytowalny Object, Airbox, długie nazwy, wiele instancji, osadzona ramka.
- [ ] Idle, submitted, running, paused, failed, cancelled, connection lost, stale result, unresolved execution.
- [ ] Wszystkie karty ribbonu; disabled reason przez hover i fokus; command palette/menu/shortcuts zgodne.
- [ ] Tab/Shift+Tab, strzałki, Enter/Space, Esc; brak pułapek; focus po menu/dialogu; 200% tekst/zoom.
- [ ] Resize/drag i alternatywa klawiaturowa; float/maximize/minimize/hide/restore, jeśli zatwierdzone; brak Stop jako skutku ubocznego.
- [ ] Inspector: root identity, scroll, focus, draft; brak globalnego disabled/opacity podczas ACK; Object i Airbox.
- [ ] Center: moduł aktywny i jawny companion, bez niewybranych ciężkich modułów; replace/right/below, resize/close; 3D widoczny, `isContextLost()==false`, drawing buffer >0; stan kamery po powrocie. Uzgodnienie ADR 0016/spec 14 z aktualnym hostem i proponowaną spec 32 przed zmianą.
- [ ] Theme change bez utraty danych/wyboru/renderer lifecycle; brak pierwszej klatki niewłaściwego motywu.
- [ ] Kontrast tekstów i nietekstowych istotnych wskaźników, nie tylko tabelka tokenów; pomiary hover/selected/focus.
- [ ] FDM CPU/GPU i FEM CPU/GPU: kompletność słownika i provenance; makieta nie kwalifikuje fizyki ani wykonania.
