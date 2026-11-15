# BuckyBall — relaksacja w zerowym polu

Cel zatwierdzony przez użytkownika: geometria z examples/buckyball, FEM GPU double, B_ext=0; zapis stanu po potwierdzonej relaksacji. Dynamika FMR i mody są kolejnym etapem. Właściciel: codex:01a1e067-64b2-7291-9742-63bdcf0c74ad. Baza: 4c9424ca0f04135e0c724c095a94fbafba3b1752.

- [x] Odczytać params.txt i STL: Ms=400000 A/m, A=8e-12 J/m, największy wymiar=5e-6 m. Zachować dostarczony STL, bez rekonstrukcji z obrazka.
- [x] Ustalić GPU i ext4 na E: /mnt/fullmag-sp4-data, UUID 92f7a92f-eb03-4e9b-9eb8-90e82c9a258b; storage już zarejestrowany. Nie zmieniać innych grup i wyników.
- [x] Skonfigurować własną grupę Compose i sprawdzić mounty oraz runtime. Pliki zmian: examples/buckyball/relax.py i ten plan; dane runu, geometria i kopia skryptu na E.
- [ ] Sprawdzić lowering Python→IR: FEM, GPU, double, Ms/A, zerowe pole, brak anizotropii (założenie istniejącego przykładu), m0=+x, PG-BB, max 100000 kroków, tolT=1e-6 T, demag poisson_robin.
- [ ] Zbudować i zachować wspólną siatkę magnetyk+powietrze; 8 nm magnetyk, 500 nm zewnętrzne powietrze, sześcian 15 µm, wzrost 1.5. Ocenić liczbę elementów, jakość i pamięć przed solve. Oszacowanie 43 mln regularnych tetraedrów w magnesie jest tylko oszacowaniem.
- [ ] Uruchomić GPU bez fallbacku i śledzić dokładny run do terminalnego wyniku. Zaakceptować równowagę dopiero przy zbieżnym stop reason i max_torque_T<=1e-6 T, skończonych energiach i znormalizowanym m. Zachować również niezbieżny kandydat, opisany jako niezbieżny.
- [ ] Zweryfikować readback stanu, siatki i provenance; zapisać wynik i ograniczenia. To pojedynczy lokalny stan z m0=+x, bez dowodu minimum globalnego, zbieżności siatkowej/airboxu lub odtworzenia FMR COMSOL.

Rysunek COMSOL: pola rezonansowe 0.253, 0.270, 0.337 i 0.394 T, pole +x, delta m_z; nie podaje częstotliwości, tłumienia ani historii pola. Nie wyprowadzać ich z obrazka. Parametry materiału i rozmiar pochodzą z params.txt zgodnie z odpowiedzią użytkownika.

Checkpoint 15.11.2026: grupa `fullmag-worktree-fullmag-ae5de860b67b5503`, port 3347, prywatna sieć 10.234.92.0/24, budżet backendu 64 GiB/8 CPU. Pierwsza próba 16e24286294b4da59a176242fa9ee2de zakończona `failed-confirmed` oficjalnym helperem po wyczerpaniu puli sieci; bez Solve i bez zmiany innych grup. Kolejna próba buduje backend.

STL ma dwie zamknięte powłoki o przeciwnych orientacjach: 172480 i 190036 trójkątów; każda ma charakterystykę Eulera -60. Podpisane objętości w jednostkach STL: +8.55315827841502 i -5.346134423196298. Objętość materiału po skalowaniu: 2.600723784728423e-18 m³. Wspólny mesher domyślnie tworzy bryłę z każdej powłoki, dlatego przykład używa jawnego importu siatki z domenami ścianki/powietrze wewnętrzne/powietrze zewnętrzne. Implementacja pozostaje wyłącznie w przykładzie (`build_hollow_mesh.py`), bez zmiany solverów.

Test `test_hollow_mesh.py`: RED (brak modułu), następnie GREEN w zarządzanym backendzie; 1 test, 0.600 s. Analityczny wydrążony sześcian: objętości 7/1/56, dodatnie tetraedry, brak komórek magnetycznych w kanale, wspólne węzły na interfejsach. Sprawdzenie składni i `git diff --check`: PASS. Rzeczywisty STL: trwa oddzielna siatka kontrolna 32 nm, bez solvera i bez kwalifikacji naukowej.

Interpretacja rozmiaru odziedziczona po istniejącym przykładzie: największy wymiar bbox=5 µm; średnica sfery opisanej na tym STL wynosi wtedy ok. 5.093 µm. Nie utożsamiać obu definicji.
