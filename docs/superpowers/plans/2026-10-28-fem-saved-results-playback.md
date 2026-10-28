# Odtwarzanie folderów FEM

Cel: ten sam przepływ Home → Open results viewer → Inspector czasu → viewport3d dla zapisanych pól FEM, bez aktywnej sesji i bez ponownego Solve.

Baza: 9479b0d6f9515a186155551efb1d651a404e4fbb. Worktree: fem-saved-results-playback-20261028. Grupa: fullmag-worktree-fem-saved-results-playback-20261-d7d5bc32322ca8c1, port3398.

## Kontrakt

- Zachować starszy deskryptor FDM fullmag.saved_playback.v1.
- FEM używa jawnej geometrii fullmag.fem_p1_field_geometry.v1, kanonicznego MeshIR i maski aktywnych węzłów, związanej przez SHA256 z deskryptorem.
- Zarr pozostaje float64LE; FEM wymaga jawnego field_layout. AoS [sample,3*N] oraz natywny SoA [sample,3,N]/[sample,3*N] są konwertowane do AoS HTTP; jedna pełna klatka na chunk. Węzły pola odpowiadają dokładnie kanonicznym węzłom geometrii H1/P1.
- Metadane pozostają małe; geometria FMMT2 i wsparcie FMSP przez binarny endpoint z kontrolą rewizji. Wspólne walidatory i kodeki, bez nowego formatu siatki.
- Import nie zgaduje mapy DOF, nie pobiera aktualnej siatki solvera i nie wykonuje skryptu źródłowego. Inne reprezentacje są jawnie odrzucane.
- Ten sam Canvas, kamera, Inspector i kontroler. Geometria powstaje po zmianie źródła; klatka aktualizuje wyłącznie kolor. Powierzchnia obejmuje w pełni aktywne komórki, także granicę z nieaktywnym obszarem.

## Kroki i odbiór

- [x] Rozpoznanie istniejącej geometrii, kodeków i czytnika folderów; izolacja i rejestr właściciela.
- [x] Czytnik FEM, rewizja, endpoint binarny i testy błędów.
- [x] Generowany kontrakt, facade/resource hooks i adapter powierzchni z maską.
- [x] Testy FDM bez regresji, FEM mixed cells/nodal order/support, lint/typecheck/architecture.
- [x] Rzeczywista przeglądarka: widoczny WebGL, brak utraty kontekstu, zmiana pól, stabilna kamera/siatka/Inspector, brak zapisów sesji. Oddzielić fixture od dowodu rzeczywistego solvera.
- [ ] Review, wymagane CI, integracja i kwalifikowany cleanup.

Zgoda użytkownika na testy funkcji i wymagane CI zachowana z konwersacji. Nie uruchamiać nowego Solve tylko dla sprawdzenia odtwarzania.

## Dowody końcowe

- Wznowienie po restarcie Dockera: przypięte recovery iteracji 165114390496425aa7c6de001ad01cfa przez host-device-reattest 619926c25c644c3a9b5db5e73afffc56; resume 0b69c21b3fd14646846dad70e55cd7d8. Alias WSL `/state` jest rozwiązywany przez obserwowany filesystem; 9 testów procedury przeszło.
- Czytnik Rust: 59 testów. UI po poprawce kadru: lint i typecheck przeszły, 8913 testów przeszło, 1 istniejący pominięty. Pomocniki codegen/browser: 49 testów. Pełny lint i kontrola architektury przeszły przed ostatnią, ograniczoną zmianą kadru; ostatnie pliki kadru mają osobny zielony lint.
- HTTP FEM: wszystkie 5 klatek natywnego SoA porównane niezależnie z AoS HTTP; SHA i długość FMMT/FMSP zgodne. Fixture jest syntetyczne (2 tetraedry, 5 węzłów), nie jest wynikiem solvera.
- Browser FEM: próba 9b6ef95390264d938a35650c4dce39f1, klatki 0/2/4. Widoczny canvas 649×683, brak utraty WebGL, zmienne pole, stabilna geometria/kamera/Inspector, brak mutacji sesji. Końcowy PNG obejrzany: obiekt mieści się w kadrze.
- Browser FDM/YIG: próba 86768671249048b292e3f81e59429961, 801 klatek, sprawdzone indeksy 0/400/800 i hashe oryginalnych pól. Brak regresji odtwarzania i utraty WebGL. SwiftShader kwalifikuje UI, nie sprzętowe GPU ani fizykę FEM.
- Pierwsza próba przeglądarki po restarcie 75220c403394445cb17190245561f07d zatrzymała się na timeout portu podczas kompilacji strony; po potwierdzeniu HTTP 200 powyższe próby przeszły.
- Logi, HTTP JSON, browser JSON i zrzuty zapisano w Documents/ChatGPT/Fullmag, z prefiksem FEM-playback-20261028 lub YIG-playback-FEM-regression-20261028. Końcowy zrzut FEM: FEM-playback-20261028-final.png.

- Końcowe testy API: 3/3 passed (`saved_playback_`), obejmujące FDM, FEM geometria/SoA/etap oraz odrzucanie sprzecznych metadanych i zmienionego digestu. Log: api-tests-passed.log.
