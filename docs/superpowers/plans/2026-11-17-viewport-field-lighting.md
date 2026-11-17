# Oświetlenie powierzchni pola w Presentation

**Cel i zatwierdzony projekt:** kolorowana magnetyzacją powierzchnia w istniejącym Presentation reaguje na światła/HDRI, rzuca i odbiera miękkie cienie oraz korzysta z AO. Scientific zachowuje dokładne kolory i wyłącza efekty zmieniające te kolory. Użytkownik zatwierdził ten podział 2026-11-17. Jasność w Presentation jest prezentacyjna; UI musi to jasno komunikować.

**Architektura:** zachowujemy interpolację pola, palety, projekcję zespoloną i topologię. W Presentation kolory pola zasilają materiał MeshStandardMaterial przez onBeforeCompile; korzystamy z istniejących świateł, HDRI, cieni i kompozytora. Scientific zachowuje obecny ShaderMaterial. Zmiana materiału nie przebudowuje topologii. FDM z kolorami instancji korzysta z materiału standardowego.

**Rozważone podejścia:** samo zwiększenie świateł nie działa na obecne materiały unlit; globalne cieniowanie zmieniłoby Scientific; wybrano istniejący Presentation z cieniowanymi kolorami pola. Bez nowych zależności ani zmian fizyki.

**Wykonanie:** agent główny odpowiada za adapter materiału, FEM, testy shaderów oraz managed runtime/browser. Jeden bounded worker Luna max odpowiada za profile materiałowe, FDM, ochronę postprocessingu i teksty ustawień z testami. Wspólny kontrakt: magneticSurface.presentation: { roughness: number; metalness: number; shadows: boolean } | null; shadeStrength 1 dla oświetlonego Presentation, 0 w Scientific.

## Kroki i kryteria odbioru

- [x] Test regresji: pola w Presentation mają materiał PBR, a Scientific pozostaje unlit; przełączenie nie gubi uniformów, palety, opacity ani projekcji zespolonej.
- [x] Adapter shaderów pola do standardowego materiału Three.js, podpięcie do MeshPartLayer oraz fallback powierzchni.
- [x] Profile/cienie/FDM oraz AO w Presentation; Scientific nadal blokuje zmiany kolorów. UI objaśnia różnicę.
- [x] Uruchomienie wyłącznie we własnej grupie Compose fullmag-worktree-fullmag-2a179130f8a085e4. Testy źródeł mogą być lekką diagnostyką, build i managed runtime wyłącznie przez launcher.
- [x] Typecheck, lint bez ostrzeżeń, testy frontendu i przeglądarka: widoczny canvas, żywy WebGL, niezerowy drawing buffer. Porównanie Scientific/Presentation na geometrii buckyballa i jednolitym +X, zmiana światła, AO/cieni, powrót do Scientific i brak nieuzasadnionych przebudów topologii.
- [ ] Review, commit, push, PR/CI, merge i weryfikacja integracji; cleanup tylko po potwierdzeniu właściciela i braku konsumentów. Blokady zapisać w rejestrze.

## Ryzyka do sprawdzenia

Mikrometryczne współrzędne i precyzja cieni/AO; istniejące tryby scalar/orientation/complex/tensor; przełączenie renderMode po kompilacji shaderów; clipping i opacity; referencje materiałów i ich zwalnianie; brak przebudowy geometrii podczas animacji pola. Dotychczasowy runtime na 3350 pozostaje odrębnym aktywnym worktree z cudzymi zmianami.

## Dowody i decyzje

Punkt startowy: e5ddb57fd1db4cff8baf507ac961b114670b03e9. Rejestr: viewport-field-lighting-20261117, owner codex-01a1e864, worktree fullmag-2a179130f8a085e4. Modern Web Guidance: zapytania o 3D/WebGL nie dostarczyły pasującego przewodnika o oświetleniu; apply-webgl-shaders dotyczy eksperymentalnego canvas-html, którego nie używamy. Context7: monthly quota exceeded; aktualna dokumentacja Three.js pobrana bezpośrednio z oficjalnej strony.

Checkpoint 2026-11-17: kontrola typów i lint bez ostrzeżeń przeszły; pełny Vitest (z FULLMAG_TEST_SOURCE_ROOT=/opt/fullmag/source) zakończył się 9793 PASS w 947 plikach. Testy regresji adaptera oraz invalidacji wariantu opacity/side miały rzeczywisty RED→GREEN. Niezależne review Sol medium znalazło P2 dotyczące OPAQUE/DOUBLE_SIDED po zmianie opacity; poprawka applyScalarSurfaceMaterialPolicy i jej test zostały zaakceptowane przy ponownym odczycie. Nie powtarzano pełnego review.

Managed DEV: attempt 29aad59475c44dc8a82e86660d43f233, config_sha256 29c26b9071462d665a0ff080f54fa73f3a3ef0401dea87811492d8cdbff34804, state succeeded, port 3365. Pierwszy start odrzuciła wyczerpana pula sieci; failure-only reconciler potwierdził terminal failed-confirmed przed kolejnym startem z jawną podsiecią 10.234.96.0/24. Zachowano dowody oryginalnej próby i nie usuwano obcych sieci. Chromium 151 sprawdził renderer z tego worktree na odczytanej siatce buckyballa; proxy blokuje mutacje i modyfikuje wyłącznie testowe ustawienia widoku, zachowując wartości pola. Wynik PASS: Scientific czerwony kanał p05=p95=255, Presentation p05=143/p95=255, ta sama geometria 196126 wierzchołków, HDRI oraz cast/receiveShadow aktywne. Zmiana azymutu światła zmieniła 26197 pikseli; round-trip do Scientific mieścił się w tolerancji <50 pikseli i przywrócił p05=p95=255. Cztery klatki miały aktywny WebGL i drawing buffer 741×507, bez błędów renderera. Brak kwalifikacji wydajności sprzętowego GPU lub fizyki.

Commit implementacji: ea1740b1f9171afd336afe7dff54431d3718d24b. Synchronizacja z origin/master 2d06f6686cc7175d2204292f4c384c8543885fc4 utworzyła merge 0fd86f26e709a7310368d17c41c7abffa11cd530; zmiany upstream dotyczyły dokumentacji, drzewo apps/control-room pozostało identyczne z przetestowanym. Logi testów i dowód przeglądarkowy: /state/development/field-lighting-proof w prywatnym wolumenie frontendu. Advisory React Doctor uruchomiony przez hook nie ukończył analizy: błąd deserializacji TSNamespaceDeclarationKind w oxlint przy istniejącym declare global; nie jest to zielony dowód tego narzędzia. Typecheck, ESLint oraz Vitest nie wykazały tego problemu. Nie zmieniano konfiguracji ani progów skanera.

## Dostępność wyboru trybu w Inspectorze

Użytkownik wskazał, że w Quality widzi Figure/Interactive i nie znajduje Presentation. Niezależne osie zachowano: wspólny `Viewport3DVisualizationModeControl` pokazuje stale widoczne Scientific/Presentation nad zakładkami, natomiast Quality profile wybiera jakość. Ten sam kontroler jest na górze starszego dialogu. Ponowne kliknięcie aktywnego trybu niczego nie zmienia, w szczególności nie włącza ponownie ręcznie wyłączonego AO.

Weryfikacja UI: RED 4 niepowodzenia/6 PASS, następnie focused 10/10 PASS. Aktualny pełny zestaw: **9796 testów PASS w 947 plikach**; typecheck i lint PASS. Niezależne review wyłącznie nowego fragmentu UI: approve, bez findings. Chromium potwierdził oba widoczne tryby w Quality, wybór Presentation klawiszem ArrowRight, zachowanie profilu Interactive, pojedynczy radiogroup i stan po zmianie zakładki. Powtórne sprawdzenie renderera zachowało ten sam wynik pikselowy i tożsamość geometrii. Dowód `browser/proof.json` zawiera `ui.modeVisibleInQuality=true`, `ui.keyboardModeSelection=true` i `ui.qualityUnchanged=Interactive`. Zrzut Inspectora zapisano po zakończeniu przejść CSS, żeby uchwycić docelowy kontrast etykiet.

Własna grupa została zatrzymana przez native drain (iteration 50d0698be6b34b2c88d0ad207331b40e), a następnie wznowiona do weryfikacji UI: resume 78b26a1836b04f3ba2d0458cb383fc4c, config_sha256 bez zmian, state succeeded. Aktywnego worktree i sesji na 3350 nie modyfikowano. PR: https://github.com/MateuszZelent/fullmag/pull/441; integracja i cleanup pozostają do zamknięcia po aktualizacji PR i CI.

Checkpoint skryptów QA: dostosowano odczyt i wybór trybu do radiogroup, wszystkie etykiety Quality profile oraz generator zrzutu dokumentacji. Przeglądarkowy proof wywołuje teraz także istniejące helpery QA: `ui.existingQaControlsCompatible=true`; pełne porównanie pikseli, cieni, WebGL i round-trip Scientific nadal PASS. ESLint czterech zmienionych skryptów PASS. Kod produktu i 9796 zielonych testów jednostkowych nie zmieniły się od d258d1fd594b8f3de41443fff5d1bd96eeb6c883. Nie powtarzano pełnego zestawu wyłącznie po zmianie selektorów QA.
