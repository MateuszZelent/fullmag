# Plan wdrożenia inspektora i paska 3D

**Cel:** wariant COMSOL zatwierdzony poleceniem użytkownika: pasek akcji i niemodalny inspektor widoku.
**Architektura:** viewport-3d nadal posiada preferencje i edycję kamery; Inspector używa publicznego komponentu UI. Istniejący inspektor zaznaczenia pozostaje zamontowany podczas zmiany kontekstu. Jeden canvas i jeden właściciel zasobów.
**Technologie:** obecne React/TypeScript, wspólne Radix/shadcn-style UI i tokeny --fm-*. Bez nowych zależności.
**Specyfikacja:** docs/superpowers/specs/2026-11-15-viewport-comsol-ui-design.md.
**Baza:** 4c9424ca0f04135e0c724c095a94fbafba3b1752. Branch codex/viewport-comsol-ui-20261115, worktree fullmag-1857ba4ad40b103c, owner codex-01a1d1b5.

## Ograniczenia

Buildy/testy wyłącznie w grupie Docker tego worktree. Zachować naukowe kolory, aktualny wybór jakości i wszystkie tryby FDM/FEM. Nie zmieniać sesji użytkownika ani cudzych grup. Raporty po polsku; kod i commity po angielsku. Nie powtarzać zielonych testów bez nowej przyczyny.

## Ryzyka do review

- Ukryty inspektor zaznaczenia zachowuje draft i root, a niewidoczne pola nie przejmują fokusu.
- Historyczna kamera nie zapisuje zmian do żywej sesji; zmiana właściciela unieważnia stare Apply.
- Globalny inspektor nie uruchamia zasobów ciężkiego viewportu, gdy 3D jest nieaktywne.
- Mały viewport i DPR2 nie powodują kolizji narzędzi, formularzy ani utraty WebGL.
- Migracja komend i selektorów browser QA zachowuje pełne asercje obrazu, kamery, PNG i błędów.

## 1. Treść ustawień i inspektor

Pliki: nowe components/Viewport3DSettingsContent.tsx, Viewport3DInspectorOutlet.tsx i viewport3dInspectorState.ts, kamera/adaptor UI; InspectorModule.tsx, public.ts, manifest.ts i powiązane style/testy.

- [x] Testy kontekstu bez zmiany Selection, zachowania draft/root i regionu ustawień bez modalnego overlay.
- [x] Przenieść ustawienia do czterech zakładek ze wspólnymi kontrolkami, opisać przyczyny niedostępności i dodać reset sekcji.
- [x] Włączyć publiczny komponent do obecnego Inspectora bez przekazywania stanów serwera przez shell. Kamerę skierować przez dotychczasowego właściciela i test stale owner.
- [x] Focused testy i adekwatna kontrola typów; commit ukończonego fragmentu.

## 2. Pasek narzędzi i status

Pliki: nowy components/Viewport3DToolbar.tsx i test/style, Viewport3DModule.tsx, Viewport3DAppearanceHud.tsx, manifest.ts.

- [x] Testy przycisków, poleceń, aktywnych stanów, nazw dostępnych i nawigacji klawiaturą.
- [x] Pogrupować istniejące akcje, przenieść statystyki do statusu, a zaawansowane nakładki do uporządkowanego panelu Layers.
- [x] Zachować krytyczne błędy, source/execution selector oraz historyczny Return to live.
- [x] Focused testy, review i commit fragmentu.

## 3. Browser i integracja

Pliki: odpowiednie browser QA helpers, spec modułu i checkpoint dowodów.

- [x] Zaktualizować wyłącznie odnajdywanie nowych kontrolek; nie osłabiać asercji obrazu, kamery, PNG, kontekstu i błędów.
- [x] Sprawdzić keyboard/focus, dwa motywy, wąski i szeroki viewport, DPR1/2, naukowy/prezentacyjny, zapis preferencji, kamerę i eksport.
- [x] Typecheck, lint0, pełne testy, architecture hygiene i React Doctor w grupie Docker.
- [x] Niezależne review źródeł i poprawek.
- Integracja po akceptacji PR: wymagane CI, merge, main fast-forward i kwalifikowany cleanup; wynik w rejestrze operacyjnym.

## Dowody odbioru

Interfejs wdrożono i zweryfikowano w grupie `fullmag-worktree-fullmag-1857ba4ad40b103c`, z frontendem na porcie 3294. Oba serwisy korzystały z tego samego checkoutu. DEV attempt `f321de26130b4ccfa6083b8c306cf4f3`, config `d2fec3b379a768221c6b439f45222fa4d3de5b9128cbe7a6e6582923cd501287`.

| Bramka | Wynik |
| --- | --- |
| Pełne testy Control Room | 9782/9782 testów, 2195/2195 suites, exit 0 |
| Typecheck, lint0, architecture hygiene | exit 0 |
| React Doctor 0.9.12, porównanie z bazą | 0 errors, 0 usterek produkcyjnych; 15 warnings `test-noise` w skryptach QA, przejrzanych bez suppressions |
| Managed browser QA | `c63dbcb48e0244e5a5dcc20046a6f5f9`, succeeded, exit 0 |
| JavaScript/HTTP w przeglądarce | 0 page errors, 0 console errors, brak HTTP errors |
| Inspektor | Zachowany root, draft obiektu i kamery, scroll 64 px, authored revision i canvas |
| Toolbar | Jeden tab stop, Home/End, projekcja w obie strony |
| Responsywność | 480×320, cztery wymagane kontrolki dostępne, widoczne liczby kontrolek 5/6/6/7, brak kolizji |
| Preferencje | Zachowane po reload na rzeczywistej trasie `/session/:name`, ta sama sesja |
| Kamera, PNG i motywy | Przeszły testy kamery, eksportu 1×/2× i układu w jasnym/ciemnym motywie oraz DPR 1/2 |
| 20 cykli 3D/2D | Wszystkie próbki 2D: zero śledzonych zasobów. Przed/po 3D: 8 geometrii, 1 tekstura, pozostałe liczniki zero |
| Idle | Trzy próbki co 350 ms: przyrosty klatek 0/0/0 |

### Checkpointy kodu

- `bc5550b040916c7565a962a6eab1ef9e33a5ded4`: pasek i Inspektor; testy komponentów, typecheck, lint i review.
- `c257bbb6da07a988bf048594df3da501afd16223`: korekta trzech nieaktualnych testów; focused 151/151.
- `47eb3994519022db2d367668f0335b3a2b41dc43`: jeden nagłówek i osobne przewijanie; focused 21/21, pełne 9778/9778, review.
- `476b391649333b5dfb6e1dc3006349d5099c7d37`: aktualne liczniki diagnostyczne bez aktualizacji Reacta; regresja red/green, focused 23/23, końcowe 9782/9782 i pełny browser QA.

### Własność i istotne poprawki

- Kamera i polecenie projekcji używają zamontowanego właściciela live/saved. Stary owner nie usuwa następcy; szybkie przełączenia mają testy. Nie dodano zapisu historycznej kamery przez live registry.
- Złączono akcje panelu i zakładki kontekstu w jednym nagłówku. Każdy force-mounted panel ustawień posiada własny scroll. Selection zachowuje swoje drzewo komponentów.
- Test lifecycle ujawnił nieaktualny debug snapshot: baseline zgłaszał 0 tekstur, a wszystkie powroty 1, mimo zerowych liczników w 2D. `track/release` nie publikowały licznika, a passive effect używał snapshotu z renderu. Właściciel publikuje teraz aktualne liczniki bez `notify`, invalidacji GPU i timerów. Test regresji był czerwony przed poprawką; focused 23/23 po poprawce. To korekta wiarygodności diagnostyki, nie twierdzenie o zmniejszeniu pamięci.
- Trzy nieaktualne testy Inspectora występowały już w bazie: sprawdzono identyczność testów i ich konsumentów. Asercje odzwierciedlają teraz delegację Study i powiązania label/input/unit, zachowując wymagania dostępności. Minimalny testowy DOM otrzymał brakującą metodę `append`.
- React Doctor porównał 39 plików z oryginalną bazą przez pomocnicze metadane Git w prywatnym wolumenie; nie zmieniał źródeł. Sekwencyjne operacje QA są zależne, bo przełączają zakładki jednej strony. Automatyczny hook hosta nie zakończył oxlint z powodu błędu deserializacji; nie jest dowodem bramki. Powyższy wynik pochodzi ze skanu zarządzanego.

### Dowody i granice

Raport pełnych testów: `private/frontend/verification/viewport-comsol-ui/full-tests-final-resource-counters.json` w wolumenie grupy. Receipty i pełny wynik browser QA: `browser-qa/attempts/c63dbcb48e0244e5a5dcc20046a6f5f9`. Raporty źródeł są kopiowane z prywatnego namespace frontendu do zachowywanego katalogu `verification/viewport-comsol-ui` przed retencją.

Własna sesja `session-18e84c623e5c99ec00004d6e` ma przesunięty obiekt QA i bezpolową bryłę `qa-studio-box`, bez aktywnej fizyki tej bryły. Istniejący obiekt zachowano. Nie uruchomiono Solve. Dwa znane `mesh_build` zakończyły się odpowiednio błędem i sukcesem; `compute_fields` zostało odrzucone HTTP409 przed ACK z powodu braku terminalnego runu, bez ponowienia. Kolejka potwierdziła pending/accepted/dispatched/running=0 oraz brak komendy compute_fields.

Przeglądarka używała WebGL2/SwiftShader. Wynik kwalifikuje interfejs i śledzony lifecycle tego scenariusza; nie kwalifikuje pól FDM/FEM, fizyki, sprzętowego FPS ani ray tracingu. Zapisana kamera ma dowód źródłowy/testowy owner fence; nie przypisujemy jej osobnego testu saved dataset w runtime.

Natywna operacja tworzenia worktree początkowo nie zakończyła rejestracji aplikacji, a attach odmówił ownerless. Faktyczny czysty checkout i właściciela zweryfikowano i zapisano w rejestrze repozytorium; późniejszy `list_artifacts` potwierdził przyłączenie tego worktree. Nie zmieniono zabezpieczeń ani bazy metadanych aplikacji.

Integracja przez PR i kwalifikowany cleanup są odnotowywane po wykonaniu w rejestrze `storage/index/fullmag-1857ba4ad40b103c.json`, wraz z wynikowym SHA, PR i receiptem retencji.
