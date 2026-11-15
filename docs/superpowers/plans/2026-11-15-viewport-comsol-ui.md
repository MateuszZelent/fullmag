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

- [ ] Testy kontekstu bez zmiany Selection, zachowania draft/root i regionu ustawień bez modalnego overlay.
- [ ] Przenieść ustawienia do czterech zakładek ze wspólnymi kontrolkami, opisać przyczyny niedostępności i dodać reset sekcji.
- [ ] Włączyć publiczny komponent do obecnego Inspectora bez przekazywania stanów serwera przez shell. Kamerę skierować przez dotychczasowego właściciela i test stale owner.
- [ ] Focused testy i adekwatna kontrola typów; commit ukończonego fragmentu.

## 2. Pasek narzędzi i status

Pliki: nowy components/Viewport3DToolbar.tsx i test/style, Viewport3DModule.tsx, Viewport3DAppearanceHud.tsx, manifest.ts.

- [ ] Testy przycisków, poleceń, aktywnych stanów, nazw dostępnych i nawigacji klawiaturą.
- [ ] Pogrupować istniejące akcje, przenieść statystyki do statusu, a zaawansowane nakładki do uporządkowanego panelu Layers.
- [ ] Zachować krytyczne błędy, source/execution selector oraz historyczny Return to live.
- [ ] Focused testy, review i commit fragmentu.

## 3. Browser i integracja

Pliki: odpowiednie browser QA helpers, spec modułu i checkpoint dowodów.

- [ ] Zaktualizować wyłącznie odnajdywanie nowych kontrolek; nie osłabiać asercji obrazu, kamery, PNG, kontekstu i błędów.
- [ ] Sprawdzić keyboard/focus, dwa motywy, wąski i szeroki viewport, DPR1/2, naukowy/prezentacyjny, zapis preferencji, kamerę i eksport.
- [ ] Typecheck, lint0, pełne testy, architecture hygiene i React Doctor w grupie Docker.
- [ ] Niezależne review; push, PR, wymagane CI, merge, main fast-forward i kwalifikowany cleanup.

## Checkpoint

Natywne create_worktree utworzyło czysty checkout o wskazanym HEAD, ale proces rejestracji aplikacji pozostał creating; attach odmówił weryfikacji ownerless. Repozytoryjny rejestr właściciela został zapisany; dalsze narzędzia używają dokładnej ścieżki. Nie zmieniono ochrony ani bazy metadanych aplikacji. Toolchain i grupa `fullmag-worktree-fullmag-1857ba4ad40b103c` uruchomione przez zarządzaną ścieżkę; frontend na porcie 3294, backend i frontend z tego samego checkoutu. DEV attempt `f321de26130b4ccfa6083b8c306cf4f3`, config `d2fec3b379a768221c6b439f45222fa4d3de5b9128cbe7a6e6582923cd501287`.

Zaimplementowano pasek, cztery sekcje Inspectora i portal z właściciela viewportu. Przegląd źródeł wykrył projekcję zapisanej sceny skierowaną do żywego rejestru; zastąpiono ją tokenowym właścicielem polecenia i testami szybkich przełączeń oraz braku właściciela.

Dowody częściowe: testy nowych komponentów, manifestu i projekcji zielone; architecture hygiene zielone. Testy Planar wymagały dodania standardowej metody `append` w minimalnym testowym DOM (17/17 po poprawce). Cała seria jest ponawiana z istniejącym `FULLMAG_TEST_SOURCE_ROOT=/opt/fullmag/source`, aby test legacy widział źródła spoza shadow workspace.

Browser attempt `9471b018be6840f7b241a4bee4915852` potwierdził: jeden tab stop paska, Home/End, zachowany draft obiektu i kamery, ten sam root i scroll 64 px, projekcję w obie strony, niezmieniony authored revision oraz ten sam canvas z kontekstem WebGL i buforem. Brak błędów page/console/HTTP. Pełna bramka jeszcze nie przeszła: diagnoza dostępności Inspectora po zmianie rozmiaru. Nie jest to dowód zakończenia całego browser QA.

Własna sesja QA `session-18e84c623e5c99ec00004d6e` ma jeden mały obiekt i wygenerowaną siatkę; nie uruchomiono Solve. `compute_fields` został odrzucony HTTP409 `accepted_materialization_run_active` przed ACK (commands.rs: submit_new_structured_command → enforce_session_command_admission), bo nie istnieje terminalny run. Żądania nie ponawiano. Brak kwalifikacji pól, fizyki lub sprzętowego ray tracingu.
