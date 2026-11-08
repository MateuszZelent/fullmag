# Diagnostyka pierwszej odmowy J — implementacja i preflight

08.11.2026. To odbiór kodu i przygotowania, nie zaakceptowany wynik V/J/H.
Plan zatwierdzony przez użytkownika:
2026-11-08-rt0-center-first-failure-diagnostic-proposal.md,
SHA256 2d85f2f2f063daf5f73919a68a689a1ead05ec24352f1cf513eb029c380a9563.

## Wykonany zakres

- 4e10cc82e24061b98594c1d738798735f0279e9f: pięć nowych testów runnera (w tym dwa warianty kolejności w jednym teście),
  regresja pełnego worker_failure_reason/receipt oraz jawne filtry CI.
- 0d45fc7b6ab50b00a3a9b24dc3a25216f4a4bd2b: prywatny helper
  verify_center_current, wywołany w dotychczasowym miejscu XYZ/J.
- c686a4ce2fb4f2d0f220df836910c967edac2d21: jawny typ None::<String>
  w oczekiwanym JSON testu po błędzie E0282 kompilatora.
- Brak zmiany predykatu, 128 epsilon64, pierwszej osi/komórki, affinity,
  canonical moments, publicznego API, schematu accepted wyniku lub fizyki.
- Normalny sukces nie tworzy świadka. Odmowa zachowuje oryginalny początek
  komunikatu i dopisuje fixed-array JSON fullmag.rt0_center_failure.v1.
- Bity f64/u64 są hex16; pola niefinitywne nie są liczbami JSON.
  Cztery flux w canonical sorted-ID sign mają kolejność opposite local vertex;
  brakująca ściana to null, bez zastąpienia pierwotnej odmowy.

Pierwszy RED w GitHub42513314551 wykazał trzy E0425 dla brakującego helpera.
Dopiero potem dodano implementację. Pierwsza próba GREEN42513968685
zatrzymała się na E0282 w fixture None; poprawiono wyłącznie typ testu.
Oba własne workflow anulowano po zakończonym nieudanym kroku, aby nie
uruchamiać dalszych niezwiązanych always-steps. Nie anulowano runtime lub Solve.

Na c686a4ce2fb4f2d0f220df836910c967edac2d21 ukierunkowany krok
Run RT0 center refusal diagnostic contracts zakończył się success:
https://github.com/MateuszZelent/fullmag/actions/runs/42514370671.
Ukierunkowany krok wykonał 16 testów runnera (w tym pięć nowych) i trzy
testy przekazywania raportu workera (w tym jeden nowy): wszystkie PASS.
Cały workflow w pierwszym wykonaniu zakończył się failure w istniejącym
exhausted_stale_sample_retry_defers_second_read_and_authorization_without_consuming_claim_start_lease
na asercji authorization_retries>0. Test i pętla ponowień są identyczne
przed i po tej diagnostyce. Pętla sprawdza deadline po pierwszej operacji,
a test daje jej100ms; opóźnienie pierwszego odczytu może zużyć to okno.
To hipoteza, nie potwierdzona przyczyna: log nie zawiera zwróconego błędu.
Uruchomiono jedno ponowienie failed job na niezmienionym commicie,
bez zmiany testu lub runtime. Jego końcowy wynik pozostaje osobną bramką.
Nie dopuszczono buildu na podstawie samego zielonego kroku diagnostyki.
Nie kompilowano lokalnie testów Rust. Niezależny review czterech plików
nie znalazł Blocker/Required; przegląd rozdzielał istniejące dirty
optymalizacje affinity/moments, których nie dołączono do tych commitów.
Stan indeksu 63 wcześniejszych wpisów pozostał identyczny:
f8c8d727f21451b25db1d2050015b469ad6bdb00b07fdba84136095367eb6fd3.

## Wejście i zatrzymanie przed buildem

Zachowano identyczny gotowy request40728Tet4/14194nodes/20H.
Nowy run to run-d04ef5217d24a697985f08e449c0648bbc5629402b7be74f6292ce08abfe7046.
Nowy compact SHA256:
d2c8add5027af0fa253643578fe82415c9ed1b1ee33d6f8866217b2c3050d656.
Odebrany JSON diff zawiera dokładnie dwa pola:
run_intent.specification.run_id i run_intent.idempotency_key.
Nie wygenerowano nowej siatki i nie wysłano requestu.

Scena i wygenerowany skrypt nadal odpowiadają zapisanym hash:
5a78f67548162c0e33c78324573ebf680b9bf6f4de9d0cd2aa0cc6600173c864
i d6c8d55caf95638089ba71b5a0f326f7f00094520bf79bd810f0f4aa7c0b2e94.
FMS oraz dokładny checkpoint przeszły strukturalną walidację.
Dwa katalogi runów są terminalne, kolejka jest pusta; nie zwalniano
ręcznie żadnej rezerwacji.

Pełny preflight odmówił: Saved authoring restart: native ready owner differs.
Przyczyną jest pin całego zmiennego heartbeat rekordu native owner.
Dwa odczyty wykazały zmianę wyłącznie heartbeat_at; hash pozostałych pól
pozostał identyczny. Nie zmieniano tej bramki, właściciela ani nadzorcy.

Stan liczników: managed update/build0, Submit0, materialization0, nowy Solve0.
Nie ma nowego świadka z rzeczywistej odmowy ani nowego zaakceptowanego wyniku.
Brak gwarancji zachowania świadka po awarii nadzorcy przed jego receipt.

Konkretny osobny projekt kontynuacji:
2026-11-08-generated-authoring-stable-owner-v2-proposal.md.
Kandydat v2 i jego16 testów są odizolowane w control volume; produkcyjny v1
pozostaje bez zmian i zachowuje odmowę. Zmiana wersjonowanej bramki wymaga
odpowiedzi użytkownika. Nie ponawiać odmówionej sekwencji w tle.

## Dowody

Prywatny control volume grupy3203:
verification/rt0-center-diagnostic-execution-20261108/.
Skrypt i zamrożony request naukowy są również na ext4:
examples/sushruth_2020_closed_gsg/rt0_center_diagnostic_20261108/.
To wejścia diagnostyczne, nie wynik accepted ani kwalifikowany Zarr.
Odtworzenie Fig.3 i dopuszczenie napędu LLG pozostają NOT VERIFIED.

## Przygotowana analiza offline

Samodzielny verify_rt0_center_witness.py i siedem regresji są na ext4
w examples/sushruth_2020_closed_gsg/rt0_center_diagnostic_20261108/offline-analysis/.
Testy przeszły bez wywołania Fullmaga. Weryfikator odtwarza predykat,
dokładny centroid i próbki RT0 z kanonicznych momentów ścian.
Jawnie odróżnia model zaokrąglania Python binary64 nearest-even od
niewykonanego cpp_rational::convert_to w C++. Wynik testu syntetycznego
nie jest obserwacją rzeczywistej anteny ani potwierdzeniem przyczyny runu.
Nie uzyskano jeszcze świadka z rzeczywistej odrzuconej komórki.
