# Audyt startu runtime FEM CPU — zależności CUDA

Data: 2026-10-03. Stan: diagnoza infrastruktury/ABI, **NOT VERIFIED** dla runtime i fizyki.
Nie zmieniono operatora, demaga, tolerancji residualu ani wyników dyspersji.

## Wynik pomiaru

Job #211 `c554c5361f014228a301380b8ed3487c` ma terminalny stan failed/exit2.
Etap native-build zakończył się exit0; probe dostępności przekroczył 120 s.
Osobna ograniczona diagnostyka przez `just diagnose-managed-fem-startup`
odtworzyła blokadę również dla `fullmag-bin --help`, przed znacznikiem startu.
To wyklucza wykonywanie operatora eigensolve jako konieczny warunek tej blokady.
Nie oznacza jeszcze ustalenia wewnętrznej przyczyny w bibliotece NVIDIA.

Wszystkie trzy próby programu zakończyły się timeoutem 10 s. Nie ma znacznika
`[fullmag] build:` ani wpisu przekazania sterowania do **fullmag-bin**.
Wpisy loadera dotyczące przekazania sterowania do timeout/env nie są startem
Fullmaga. Ostatni wpis `calling init` dla procesu programu wskazuje
`/usr/local/cuda/lib64/libcublasLt.so.12`. Próba ldd/readelf zakończyła się
bez timeoutu i wykazała poniższe zależności.

| Obserwacja | Wniosek | Granica dowodu |
|---|---|---|
| --help i availability blokują się przed startup stamp | Awaria występuje przed main/obsługą modelu | Nie jest dowodem konkretnej instrukcji ani backtrace konstruktora |
| Ostatni calling init wskazuje libcublasLt | Pierwszym podejrzanym jest inicjalizacja zależności CUDA | Potrzebna oddzielna próba załadowania tej biblioteki |
| CPU MFEM + SLEPc/PETSc ładuje CUDA | FULLMAG_ENABLE_CUDA=OFF nie zamyka tranzytywnego grafu zależności | Nie dowodzi wykonania kernela GPU |
| Ładowane są dwa SONAME HYPRE | Trzeba zweryfikować zgodność ABI i rozdzielenie CPU/GPU | Nie dowodzi jeszcze błędu częstotliwości lub pamięci |

## Tożsamość i artefakty

- Profil: `fem-cpu-slepc-runtime-v2`.
- Source digest: `b85acbd0d354acf7f554f72e8697c06c1508de8ff9d51fcbd8831aa38aad452c`.
- Native snapshot: `501308a35be5cfd1fafbbb83831f48efbef988ddd0d5dadf5ec33e0f18cd30ca`.
- Image: `sha256:8a508319a68c4116da81b745fdd1b084015b665d92b36b2241e1e245b5febf89`.
- Binary SHA256: `1c3da748369cea4d5cab2c956f4e67d248ef8e4b8fa471decf49896b3bbfb749`.
- libfullmag_fem.so.0.1.0 SHA256: `f4aa449ca7f37da72ed84a3da0011bf1f8b45c0eb501193cd21098dfc37f47c2`.

Artefakty względem storage projektu:
`runs/eigensolve-dispersion-plan-20260-c5dfad6d7f548079/startup-diagnostics/c554c5361f014228a301380b8ed3487c-4f5d51a4ad034800b53b63d486de237e/`.
Dowodem są `diagnostic-report.json` oraz logi w `probes/`.
Kontener `3c37c839ec8f9f129a579749989492ca7a23b61f482e10b4bbb8c1e2efd400e9`
został zatrzymany i zachowany. Hashy wejściowych nie zmieniono podczas próby.
Raport ma diagnostic_only; completed oznacza ukończenie diagnostyki, nie
zaliczenie programu. Return code probe jest wynikiem klienta Docker/timeout,
nie potwierdzonym terminalnym kodem samego Fullmaga po obserwacyjnym timeoutcie.
Zegary hosta i Docker VM mają różne wskazania; nie obliczamy czasu wykonania
przez odejmowanie timestampów pochodzących z różnych zegarów.

## Graf zaobserwowany przez loader

`fullmag-bin -> libfullmag_fem.so.0`.
Bezpośrednie DT_NEEDED biblioteki Fullmaga obejmuje CPU MFEM 4.10.0,
HYPRE.so.301, libceed, MPI, SLEPc oraz PETSc. Pełne ldd obejmuje też:

- `/opt/fullmag-mfem-cpu/lib/libmfem.so.4.10.0`;
- `/opt/fullmag-mfem-cpu/lib/libHYPRE.so.301`;
- `/opt/fullmag-deps/lib/libceed.so`, `libslepc.so.3.24`, `libpetsc.so.3.24`;
- `/opt/fullmag-deps/lib/libHYPRE-3.1.0.so`;
- libcudart, nvrtc, cuda/compat, cublas, cusparse, cusolver, curand,
  cublasLt i nvJitLink.

Nie przypisujemy jeszcze poszczególnych krawędzi do PETSc lub libceed na
podstawie samego spłaszczonego ldd. Następna stała sonda readelf dla bibliotek
obrazu ustali bezpośrednie krawędzie DT_NEEDED.
Udany #203 używał tego samego obrazu i tego samego CPU MFEM 4.10.0; nie ma
podstaw, aby twierdzić, że samo podniesienie MFEM wywołało regresję.

## Korekty wykonane i kolejne kroki

1. Sterownik ogranicza próby do 1 CPU/1 GiB, bez sieci i zapisów do źródeł.
   Kontenery i dowody zachowuje; brak automatycznego cleanupu.
2. Poprawiono Windows WinError1920 przy próbie stat-follow Linux-linków:
   is_link jest sprawdzane przed is_file. Błąd hashowania pozostawia raport
   preflightu. Sześć interpretowanych regresji PASS; bez kompilacji unit tests.
3. Mały commit `3ccd540c22b2ef2c848f5424b724af9f00d9a837` eliminuje drugi
   availability snapshot w CLI. Nie jest rozwiązaniem awarii przed main.
4. Proponowana następna próba: stałe readelf dla bibliotek obrazu, izolowane
   CDLL(cublasLt) oraz kontrolne CDLL(CPU HYPRE), bez ponownej kompilacji
   i bez zmiany FIFO. Rozszerzenie odrzucił auto-review jako dodatkowy zakres;
   oczekuje na jawne zatwierdzenie użytkownika. Nie wykonano tych sond.
5. Jeśli CPU closure wymaga GPU-zależnych PETSc/SLEPc/libceed, przygotować
   właściwy CPU stack i jego atestację. Nie zastępować bibliotek stubami,
   nie wymuszać przejścia runtime gate ani nie zwiększać timeoutu bez diagnozy.
6. Po rzeczywistym terminalnym PASS nowego managed runtime: próby Schura ±2,
   parity serial/adaptive, signed DE/BV i dalsze bramki pełnego S00–S12.

Kolejka #212/#213 pozostaje queued z powodu miejsca. Nie zlecono drugiego
ciężkiego buildu poza kolejką i nie zmieniono kolejności. Wykres nadal ma
wyłącznie dwa zaakceptowane technicznie punkty ±10 z #203; pełna kwalifikacja
naukowa, nowy GUI i integracja pozostają otwarte.


## Review sterownika i ograniczenia dowodu

Review źródłowe nie znalazło krytycznego blokera pierwotnej trasy. Wskazane
P2 poprawiono: odrzucanie duplikatów mount destination, wiązanie pełnego Id
przy inspect, atestację Path/Args i wymaganych nadpisań Env oraz oznaczenie
niedokończonego readera po join timeout jako obciętego. Root wykrył i poprawił
fixture Path/Args: Docker przechowuje je na poziomie głównego rekordu,
a nie Config. Regresja najpierw odtworzyła błąd, potem osiem testów
interpretowanych PASS. Walidator przeszedł także read-only sprawdzenie
rzeczywistego, zachowanego kontenera 3c37c839… bez ponownego startu.

Obserwowane hashe binarium/bibliotek nie są równoważne kryptograficznemu
przypięciu do terminalnego PASS receiptu — #211 nie osiągnął atestacji
runtime. Diagnostyka nie kwalifikuje tych binariów. Kolejne poprawki
walidatora nie były uruchamiane jako nowe sondy. Dokładne bajty pierwotnie
wykonanego sterownika zachowano w diagnostic-driver-snapshot.py wraz
z driver-snapshot-provenance.json w tym samym katalogu dowodów; hash
7b465a7938cff388c95c5c702c7668e0670801ef63f8c1109d719c7eb6a869c8.
Terminalnego raportu pierwotnej próby nie nadpisano.
