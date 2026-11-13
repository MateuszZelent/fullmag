# Plan wdrożenia trybu prezentacyjnego viewportu 3D

**Cel:** PBR, lokalne HDRI studyjne, miękkie cienie, AO zależne od jakości oraz rzeczywisty eksport PNG 1/2/4×, z niezależnym i domyślnym trybem naukowym.
**Baza:** 8183f3e7c1b57181f50a0c33678b40f3db4dd7c1; branch codex/viewport-studio-20261112.
**Architektura:** jeden istniejący renderer R3F/WebGL i jedna scena. Ustawienia wyglądu są preferencjami UI modułu. Dane pola, topologia i kamera zachowują dotychczasowych właścicieli. Ray tracing pozostaje poza zakresem.

## Kontrakt i decyzje

- Tryb `scientific` jest domyślny. `presentation` włącza PBR jednolitej geometrii i studyjne HDRI generowane lokalnie jako liniowa mapa equirectangular HDR bez żądań zewnętrznych. Wbudowane softboksy są źródłem otoczenia, a nie częścią modelu fizycznego.
- Scientific zachowuje kolory, shadery i mapowanie ilościowe; presentation również nie nadpisuje ilościowych shaderów. AO i bloom pozostają wyłączone przy widocznych ilościowych danych. Tone mapping nie zmienia kanałów danych.
- Jakość jest niezależna od trybu: istniejące Interactive Lite / Interactive / Balanced / Figure sterują rozdzielczością cieni i AO; najlżejszy profil wyłącza kosztowne cienie/AO jawnie. Zachowane są istniejące limity liczby wyświetlanych glyphów danego profilu; wartości pól pozostają niezmienione. Eksport zachowuje wybrany limit zamiast przełączać go na capture.
- Materiał jednolity PBR: MeshStandardMaterial, metalness i roughness jako ograniczone preferencje wizualne; nie wynikają z Ms/A/alpha.
- Cienie są ograniczone do geometrii prezentacyjnej, ze skalą kamery światła wyprowadzoną z bounds sceny, miękkim filtrem PCF, jawną jakością i zwalnianiem zasobów.
- PNG: render od nowa 1/2/4× rozmiaru CSS (nie powiększanie gotowej bitmapy), dla tła widoku i przezroczystego. Ten sam pipeline efektów; opcjonalne adnotacje skalowane. Limit boku 8192 i 16M pikseli, błąd z instrukcją zmniejszenia skali. Rozmiar, stan renderera i zasoby przywracane także po błędzie.
- Zasoby GPU mają tracker i cleanup. Renderowanie pozostaje demand-driven; brak dodatkowych canvas WebGL, ciągłych klatek, zmiany Next.js i solvera.

## Wykonanie

- [ ] Kontrakt trybu, jakości, zapisu preferencji i UI; testy normalizacji, migracji domyślnej i ochrony danych.
- [ ] PBR w FEM, FDM i prymitywach z zachowaniem ilościowych ścieżek; testy doboru materiałów.
- [ ] HDRI/PMREM, cienie i jakość AO; testy rozmiaru kamer, jakości, cleanup i wyłączenia w scientific.
- [ ] Wspólny callback renderu live/export; rzeczywisty rozmiar PNG, alpha i opcjonalne adnotacje; testy restoration/limits/parity.
- [ ] Typecheck, lint bez ostrzeżeń, pełne testy Control Room w grupie Docker zadania; browser/WebGL smoke, porównanie scientific/presentation oraz profili jakości, realne PNG 1×/2× i transparent.
- [ ] Review diff/dowodów, commity etapów, PR/CI/merge oraz kwalifikowany cleanup worktree zgodnie z AGENTS.md.

## Review focus

1. Zmiana trybu lub jakości podczas ilościowej wizualizacji zachowuje dokładne mapowanie i bufory danych.
2. Małe/duże, odsunięte i płaskie bounds nie obcinają cieni i nie tworzą NaN.
3. PNG bez adnotacji nie zawiera HUD ani ramki; transparent zachowuje pokrycie alpha i efekty geometrii.
4. Eksport przekraczający limit lub błąd GPU/enkodera nie pozostawia zmienionej kamery, rozmiaru ani aktywnych targetów.
5. Powtarzane przełączanie trybu i jakości nie powoduje stałego renderowania lub wzrostu zasobów GPU.

## Dowody

Testy/buildy wyłącznie w grupie `fullmag-worktree-fullmag-2e2b7b5de503393f`. Toolchain przygotowany zarządzaną receptą, attempt 85bbaf92355f4da2be52d41535012564. Wyniki implementacji/runtime dopisywane po wykonaniu; plan nie dowodzi ich spełnienia.


### Stan implementacji i weryfikacji — 2026-11-13

- PBR/HDRI/cienie/AO i jakość są zaimplementowane, z ochroną shaderów ilościowych. Eksport renderuje wspólny pipeline do RGBA16F i konwertuje zgodne próbki koloru/alpha do PNG; obsługuje także poświatę przy częściowym pokryciu.
- HDR MSAA na SwiftShader dawało NaN już przy stałym kolorze materiału. Produkcyjna ścieżka używa pojedynczego HDR targetu i FXAA. Shadery diagnostyczne, GPU probes i prywatna introspekcja zostały usunięte.
- N8AO wymaga stabilnego obliczania normalnych z pochodnych dla SI nanometrów: oba operandy cross są skalowane przed normalizacją. Adapter obejmuje pełną i połowiczną rozdzielczość oraz odtwarzanie shaderów po zmianie jakości; 3 testy rzeczywistego zainstalowanego passa zaliczone.
- Kamera zachowuje właściciela gestu aż do spoczynku zaobserwowanego przez update. Po puszczeniu przycisku tłumienie składa normalny zanik60Hz według upływu czasu (maksymalnie250ms na aktualizację), bez przyspieszania nowego przeciągania po idle. Testy rzeczywistych OrbitControls i scheduler:51/51.
- Eksporter:36/36 testów. Typecheck i pełny lint zaliczone przed końcową korektą tłumienia/refaktorami React Doctor; wymagają końcowego sprawdzenia. Poprzednia pełna seria9745/9745 (937 plików) sprzed adapteraAO i kamery nie jest dowodem finalnej gałęzi.
- React Doctor wykrył nowe eksporty helperów z komponentów, eager Vector2 i sekwencyjne odczyty testu. Poprawki w toku. Wąski wyjątek dodatniego useFrame w LightingRig jest uzasadniony: obserwacja targetu po scene1/HUD2 wymaga priorytetu2.5 w już ręcznie renderowanym Canvas. Niezależne review potwierdziło brak problemu; nie dodano drugiego renderu.
- Browser469751c06cf648699185878592674ffc: PBR zmienił41875 pikseli przy roughness.1/.9; wszystkie4 profileAO/cieni bez czernienia; PNGopaque/transparent/adnotacje oraz pełna kamera przeszły. Bramka układu nie osiągnęła1200px canvas przy ograniczeniu okna4000px; limit kalibracji podniesiono do8192, tolerancja canvas3px pozostała.
- Browser554be7a57ad3447483e8b62c4a4462b2 ponownie przeszedł wygląd, ale ujawnił ogon tłumienia zależny odFPS (>30s). To uzasadniło opisaną wyżej korektę czasu, bez osłabienia bramki kamery. Końcowy browser pozostaje otwarty.
- Browser działa na Playwright1.62.1/SwiftShader; nie dowodzi sprzętowegoFPS, FEM/FDM runtime ani poprawności naukowej. Własna sesjaQA `session-18e76f22b99a2b9b00004bb9` zawiera wyłącznie box40x30x10nm przesunięty80/-70/0nm, bez zlecenia symulacji. Dane ilościowe chronią testy kontraktów; ich wygląd w uruchomionej symulacji nie został tu zakwalifikowany.
- ManagedDEV: attempt `7ae2b2a54e96477cbe2d84aa222833ff`, config `47637a634b64e31cc81ee5af71e00debe89ba9ae8f78a76468f4f19c60483162`, port3292, frontend/backend healthy. Prywatne subpaths jednego control volume, bez współdzielenia prywatnego cache z inną grupą.
- Osobne commity infrastruktury: `8f36df927d83fb4da3a95ea7a210b78d00f75345` (47 testów sieci), `bf8851797efcd51374a0d26d7c88d61c032e80ed` i `3bc8626aeb22335a6fdaae43761bd4a8d58f71c0` (4 regresje wygenerowanego seeda i62 receipts). Są częścią brancha zadania; feature/PR/integracja/cleanup nadal otwarte.

### Końcowe kontrole fragmentu

- Typecheck i lint bez ostrzeżeń zaliczone po zmianach kamery i przeniesieniu resolverów. Pinned React Doctor:36 zmienionych plików,0 nowych problemów. Niezależne review ostatnich poprawek nie wskazało Required.
- Browser `2ef1928e283243f0a42d9da245608821`: PBR, jakość, kamera, layout1200x800/480x320 w dwóch motywach przy DPR1 i2, PNG1x/2x oraz lifecycle20 przejść2D/3D przeszły. Lifecycle: bez wzrostu zasobów, idle delta klatek[0,0,0], sesja niezmieniona. Całość nie ma stanu passed:20 żądań2D do planar-default bez domeny zwróciło422 `planar_default_domain_unavailable`. To nie błąd WebGL; pozostaje bramką integracji do wyjaśnienia bez ukrywania HTTPerrors.
- Pełna seria końcowa w toku, log `/state/development/viewport-studio-tests-complete.log`. Kod fragmentu można zapisać po focused/runtime/type/lint/review; merge wymaga domknięcia pełnych kontroli.
