# Diagnoza różnicy częstotliwości DE/BV — 2026-09-30

Stan: diagnoza numeryczna na archiwalnej siatce; ponowne wykonanie aktualnego
Fullmaga i zbieżność nadal oczekują. Nie zmieniono częstotliwości ani parametrów,
nie skalowano archiwów, nie dopasowywano solvera do analityki.

Niezależna słaba postać liniowego równania Landaua–Lifshitza, z consistent
P1 mass, exchange stiffness oraz zapisanym elementowym H_demag, potwierdza
13 spójnych par pól. Ich residual magnetyczny ma maksimum
2.77326473e-10.
Pozostałe 6 par nie przechodzi z powodu wcześniejszego błędu skali q/phi.
Kontrola używa m0=+x i jednorodnego H0=0.1/mu0 A/m, zgodnie z tym fixture;
nie jest uniwersalnym audytem dowolnego stanu równowagi.

Druga kontrola składa niezależnie na tej samej siatce P1 pełny Poisson,
źródła Ms*m dla dwóch przestrzennie jednorodnych obwiedni y/z oraz exchange.
Stosuje fizyczne nodalne exp(-ik*r), C^H*K*C, Dirichlet na zewnętrznych
płaszczyznach i consistent mass. To mała projekcja Ritz na 2 funkcje próbne,
nie nowa produkcyjna symulacja Fullmaga ani dokładna analityka ciągła.

| Geometria, k [rad/µm] | Fullmag [GHz] | Niezależny Ritz na tej siatce [GHz] | Analityka n=0 [GHz] |
|---|---:|---:|---:|
| backward_volume, 2 | 9.273542 | 9.273551 | 9.274234 |
| backward_volume, 7 | 9.235505 | 9.235620 | 9.243430 |
| backward_volume, 25 | 9.664769 | 9.666426 | 9.760535 |
| damon_eshbach, 2 | 9.723336 | 9.723396 | 9.725724 |
| damon_eshbach, 7 | 10.669228 | 10.669963 | 10.693658 |
| damon_eshbach, 25 | 13.384204 | 13.393452 | 13.673868 |

Przy k=25 rad/µm w DE dyskretny Nyy=0.110178, Nzz=0.864660;
analityczny P00=0.115203 i 1-P00=0.884797. W BV Nzz=0.864795.
Dyskretny k_eff^2/k^2 wynosi około 1.00366…1.00375: błąd exchange jest
mały i działa w kierunku zwiększenia częstotliwości. Główny zaobserwowany
spadek jest związany z dyskretyzacją odpowiedzi magnetostatycznej.
Około 97% różnicy DE i 98% BV między Fullmagiem a analityką k=25 występuje
już w tej dwufunkcyjnej projekcji. To mocny trop, ale nie dowód zbieżności
ani rozdzielenia błędu siatki filmu od siatki powietrza i warunku zewnętrznego.
Nie oznacza to błędnego znaku demag; słaba postać i faza zostały kontrolowane.

## Poprawki i następujące uruchomienia

- Poprawka deduplikacji zachowuje oryginalną wspólną skalę q/phi; C++ WIP,
  będzie w nowym snapshotcie, bez zmiany progu residualu 1e-8.
- Wykryto kolejny błąd planu runtime-v2: CPU MFEM nie może używać HYPRE
  skompilowanego z CUDA. Bootstrap instaluje oba CPU warianty w oddzielnym
  prefixie, zachowując biblioteki GPU. Weryfikacja obrazu i ABI oczekuje.
- Włączenie wyłącznie runtime-v2 zachowuje dotychczasowe profile, token i
  tożsamość koordynatora; 23 interpretowane testy i 4 subtests PASS.
- Plan pilotów po zbudowaniu biblioteki: DE k7 L0, BV k7 L0 (test skali),
  następnie DE k25 L0/L1/L2 i BV k25 L0/L1/L2 (test częstotliwości i siatki).
  Kolejne poziomy tylko po poprawnych residualach i przy zbieżnym trendzie.
- Każdy pilot: źródło/runtime SHA, niepuste mody, pełny residual, Poisson,
  seam, identyczne SI i materiały, rzeczywiście rozwiązany poziom siatki.
  Nowe wyniki osobno, historyczne dane zachowane.

## Dowody i ograniczenia

Wzory odniesienia i konwencje: docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md,
eq-fem-full-bloch-weak i eq-fem-full-bloch-demag. Operator źródłowy:
backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp.
Analityka: scripts/verify_fem_frequency_domain_eigen_artifacts.py,
kalinikos_slab_n0_frequency_hz. Producentów dwóch poniższych raportów nie
pokrywają jeszcze dedykowane regresje; są oznaczeni jako exploratory.
Nie zaliczają bramki naukowej, wykonania nowego solvera ani FEM GPU/FDM.

- `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\de-bv-ten-20260930\magnetic_weak_probe.py`; SHA-256 `13f7ad281df912504834149ee174b9e103d9d25f4f91e16c484ce08076a8671c`.

- `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\de-bv-ten-20260930\magnetic_weak_probe.json`; SHA-256 `5510942d237d6aee542ad83412ad0d4a66bd6d4dbade7c56cbaef476ab90d22d`.

- `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\de-bv-ten-20260930\uniform_ritz_probe.py`; SHA-256 `bcc55c14d9e4fd4aebf652a5603583b2dd09dab4d268ef1653a68b72b9cd2bfd`.

- `C:\Users\Mateusz\.codex\visualizations\2026\09\14\01a09ee1-29e6-7d51-98f0-082c5539a0d6\de-bv-ten-20260930\uniform_ritz_probe.json`; SHA-256 `f226a1bc0de55a20fbdf3d5fab0ed3be2109d9064d3388939113e8a326d9e7c1`.

### Rozdzielenie zewnętrznego Dirichleta od dyskretyzacji (diagnostyka)

Dla ciągłego uniform-film kernelu z tym samym Dirichletem w z=±(padding+t/2)
kontrola rozwiązania 1D daje przy k=25 rad/µm Nzz=0.8847968677,
identyczne z otwartą analityką do pokazanej precyzji. Przy k=7 zmiana Nzz
wynosi około -4.52e-14; przy k=2 około -6.58e-6. Zewnętrzny Dirichlet
na odległości 2 µm nie wyjaśnia więc spadku do dyskretnego Nzz≈0.8647
przy k=25. Pozostaje głównie aproksymacja P1 operatora magnetostatycznego.
Wynik ten wymaga nadal regresji wyprowadzonego kernelu i dowodu zbieżności
rzeczywistej siatki; nie oznacza zamknięcia bramki airbox dla wszystkich k,
w szczególności Gamma i bardzo małych k.

### Zweryfikowany obraz toolchaina CPU

Bootstrap przez `just runner-build-image` zakończył się exit 0. Obraz:
sha256:f12e618dce9e212fc7f1be5947fa1e92acbb9736d4820eca892b5b7dbc2eebcc.
Konfiguracje potwierdzają MFEM_USE_CUDA wyłączone i HYPRE_USING_CUDA
wyłączone; ldd przy środowisku profilu rozwiązuje libHYPRE.so.301 do
/opt/fullmag-mfem-cpu/lib. Zależności CUDA libCEED/PETSc pozostają
w obrazie; libcuda ładuje się z jego compatibility directory. To nie dowód
GPU ani wykonania żadnej operacji GPU. Produkcyjny CPU runtime Fullmaga
wciąż wymaga osobnego builda i pilota. Poprawkę matching CPU HYPRE
przeniesiono także do kanonicznego docker/fem-gpu/Dockerfile; ten pełny
Dockerfile nie był ponownie budowany (zweryfikowano bootstrap obrazu).

### Kontrakt parametrów niezależnej kontroli

Przed kontrolą Poissona parametry rekordu porównania muszą odpowiadać
hash-bound metadata.json tego samego uruchomienia. Weryfikujemy Ms [A/m],
A [J/m], gamma0 [m/(A s)], grubość [m] i H0=B0/mu0 [A/m], a także
orientację DE/BV i zewnętrzny Dirichlet. Tolerancja 32 epsilon maszynowych
pozwala jedynie na roundoff przeliczenia SI, bez fitowania materiału.
Niezgodne lub brakujące metadane należy odrzucić. Źródło kontrolera:
scripts/compare_de_bv_mode_profiles.py, validate_record_parameters i load_record.
To kontrola integralności wejść diagnostyki; nie nowa metoda fizyczna ani
zastępstwo pełnego descriptor residualu czy zbieżności siatki.

Dowody kontrolera parametrów: 9 interpretowanych testów PASS, rzeczywisty
archiwalny mod z unikalnym hashem metadata.json PASS. Ponowny Poisson dla
19 rekordów zachował max residual 0.16636683689726586; parametrów nie
zmieniono. Staged source-map exit 0. Przyrost zapisano i wysłano:
ce778712cb177bc814ab0502fd35215b292bd02d. Nowy runtime #173 pozostaje
w budowie; diagnoza skali nadal wymaga ponownego wykonania solvera.
