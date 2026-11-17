# Accepted FEM driven response v1 — projekt kontraktu

Status: propozycja do przeglądu, nie działająca capability. Data: 2026-11-17.
Decyzja: [ADR 0082](../adr/0082-accepted-fem-driven-response.md).
Fizyka i SI: `docs/physics/0700-frequency-domain-linearized-llg.md` oraz
`docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`.
Wyniki produktu: `frequency-domain-artifacts-v2.md` i
`frequency-domain-results-product-projection-v1.md`.

## 1. Cel i zaobserwowany stan

Celem jest uruchomienie z Workspace istniejącego native forced harmonic solve
wokół provided M0, zapis kompletnego widma i zespolonych pól odpowiedzi oraz
ich trwały odczyt. Nie dodajemy nowej fizyki ani nie nazywamy forced response
wektorem własnym. Damping, gamma, bias, BC, siatka i norma pozostają w jednym
Python DSL/ProblemIR/plannerze.

Bieżący BuckyBall: Ms=400000 A/m, Aex=8e-12 J/m, alpha=0.01, B=0 T,
k=(0,0,0), free, Gamma, double/strict, gamma0=221100 m/(A s), jednorodny drive
z=1 A/m. Gamma pochodzi z istniejącego default Fullmag, nie z pliku COMSOL.
Snapshot 25017 jest dopuszczony przez użytkownika do pilota;
`equilibrium_verified=false` pozostaje niezmienione. Nie uruchamiamy Relax.

Wejścia znajdują się na ext4 dysku E. Stan jest bitowo sprawdzony przez
publiczny JSON/Zarr readback; packed-plan order wiąże się ze stałą siatką
196126 węzłów i 1222155 Tet4. Mapy i provenance pozostają przy snapshotcie.
Zmiana authoring header bundle była adopcją istniejącej siatki, nie remeshem.

Compute-v2 zwrócił HTTP422 przed acceptance. `run=null`, command ledger rev0
potwierdzają brak efektu solvera. To dowód brakującej ścieżki wykonania,
a nie działającej symulacji FMR.

## 2. Zakres backendów i admission

| Realizacja | Zakres tej propozycji | Stan obecny |
|---|---|---|
| FDM CPU | bez zmian | nie jest producentem tej analizy FEM |
| FDM GPU | bez zmian | nie jest producentem tej analizy FEM |
| FEM CPU | osobny native solver i lease CPU; mały oracle/parity | brak accepted FR producer |
| FEM GPU | jawny gpu_operator_host_krylov i lease GPU | brak accepted FR producer |

Przyjęcie następuje po obniżeniu i sprawdzeniu dokładnego planu FR: FEM,
H1/P1, double/strict, free/Gamma, k=0, provided M0, native solver dostępny dla
rozwiązanego urządzenia. GPU device Krylov, modal eigen, PBC/Floquet i inne
rodziny pozostają poza tym rozszerzeniem. Istniejąca legalność native CPU/GPU
jest konieczna, ale sama nie dowodzi obsługi przez accepted adapter.

Requested i resolved wykonanie są oddzielne. Forced GPU nie dostaje CPU lease.
Host Krylov jest jawnie częścią GPU hybrid realizacji. Native execution receipt
musi zachować faktycznie wykonane operatory i UUID; nie używa time-domain
accepted-state envelope do certyfikowania analizy harmonicznej.

## 3. Snapshot i preparation

- Przygotowanie pochodzi z immutable accepted ProblemIR i planu, bez odczytu
  mutable sceny przy dispatch. Native MeshSpace evidence obejmuje ten sam
  fingerprint topologii, liczbę węzłów i rząd elementu.
- FR ma osobną gałąź w native FEM preparation; nie udaje TimeEvolution.
- Canonical equilibrium input layout jest realnym M0 w FEM H1/P1. Output
  layout `fem_frequency_response` pozostaje layoutem analizy zespolonej.
  Nie wolno akceptować tych layoutów jako zamiennych tylko przez równą długość.
- CAS materializer sprawdza digest, pełny mesh/layout i maskę magnetic/air,
  a następnie wiąże wartości do `equilibrium_magnetization`. Nie pozostawia
  wartości domyślnych ani nie wykonuje normalizacji ukrywającej uszkodzenie.
- Authored sampled M0 i state predecessor muszą przejść tę samą kontrolę
  kolejności i podparcia; overlay nie może po cichu zmieniać provided snapshotu.
- Wejściowy snapshot, mesh, parametry i ich hashe są częścią receipt wyniku.
  Akceptacja approximate nie ustawia certyfikatu equilibrium.

## 4. Porty, framing i budżety

Plan deklaruje port `response` oraz jeden `response-frequency-NNNNNN` na każdą
z góry znaną częstotliwość, w jej oryginalnej kolejności. Wszystkie outputy
zachowują jeden fizyczny `case_id`, zgodny z worker receipt. Porty nie są
nazwami plików solvera i nie zawierają ścieżek hosta.

Nowe codeki w application:

- `fullmag.fem.driven_response_index@v1`: indeks globalnych artefaktów,
  geometry/input identity, ordered frequency/port/bundle SHA i complete status;
- `fullmag.fem.driven_response_point@v1`: dokładny manifest punktu oraz jego
  jawna closure payloadów, oprawiona binarnie z length i SHA-256 każdego pliku.

Framing zachowuje dokładne native bajty payloadów pola. Wzorzec bounded binary bundle istnieje
w `antenna_inspection_bundle.rs`; nie powiela się tam fizycznego walidatora.
JSON indeksu kontrolnego ma limit 1 MiB; global bundle oraz każdy point bundle
mają limit 256 MiB. Suma bundle i buforów kolekcji musi zmieścić się w jawnie
przyznanym RAM i scratch po rezerwie native work; kontrola jednego pliku nie
zastępuje kontroli sumy. Estymator rozmiaru
należy do writera i wyprowadza bound z liczby próbek, pól, częstotliwości oraz
rzeczywistego formatu. Unknown/unbounded format zamyka admission.

Każdy plik pochodzi z jawnej listy writera/manifestu, z role, safe relative
path, byte_length i SHA. Zabronione są directory scan, symlinki, path traversal,
duplikaty i kolizje case-fold. Przekroczenie limitu nie obcina pól ani liczby
punktów; kończy się jawnym błędem. W późniejszej wersji można dodać streaming
bez reinterpretacji v1 i bez zmiany fizycznego case.

Szczyt RAM obejmuje równoczesne native dense JSON, parser/projection buffers,
wszystkie `StudyOutputPayload.bytes` i kopie codec/CAS; tak samo dla error i
recovery. Bound musi obejmować te fazy, nie tylko docelowy rozmiar plików.

Index wiąże session/run/stage/runtime i attempt/epoch, study_product=
`driven_response`, M0/hash/topology, requested/resolved/executed engine, SI,
alpha/gamma/bias, parametry solvera i wszystkie ordered point ports. Każdy
punkt wiąże frequency Hz, indeks, k/BC, excitation, convergence/residual oraz
pełne Cartesian complex XYZ dla pól przeznaczonych do wizualizacji. Sam tangent
vector nie staje się global XYZ przez zmianę etykiety.

Kompletność plików i zbieżność są oddzielne. Sukces accepted FR wymaga
wszystkich zadeklarowanych punktów, sukcesu native runnera i manifestu
`ready/complete` z dokładną liczbą ukończonych częstotliwości. Native point JSON
nie zapisuje osobnego `converged`; accepted publisher wyprowadza ten znacznik
z powyższych dowodów oraz skończonego residual spełniającego jawne kryterium.
Źródło tej oceny musi pozostać zapisane w provenance. Pierwszy
accepted kontrakt wymaga także relative residual nie większego niż jawnie
zapisana relative tolerance. Native sukces osiągnięty wyłącznie przez luźniejszy
absolute threshold nie omija tej bramki jakości i daje czytelny błąd. Niezbieżny
punkt oznacza failed attempt z zachowanym partial/diagnostic output, bez
complete indeksu. Codec nie zastępuje fizycznego walidatora solvera.

Native allow-list, walidacja indeksu/point bundle i kompletność wszystkich
zadeklarowanych portów poprzedzają terminalny Completed. Existing CAS,
study_output_manifest i immutable completed receipt przechowują właściwe
bajty. Nie dodaje się final_state, accepted_state_ref ani pozornego czasu LLG.

### 4.1. Kompaktowa projekcja odpowiedzi

Audyt writera ujawnił dodatkową granicę: oba native sweep JSON v1/v2 włączają
pełne `m_complex`, amplitudy i fazy wszystkich punktów. Samo opakowanie tych
wielogigabajtowych dokumentów jako indeksu byłoby niezgodne z control plane.
Nowy publisher tworzy `magnetic_response_sweep.v3` z małymi rekordami
częstotliwość/response/residual i jawnymi referencjami do per-point pól.
Czytniki v1/v2 pozostają dla historii; nowy wynik ma własną wersję i digest.

Nie zmienia się solvera ani native ABI. Runner/publisher po zakończeniu native
call tworzy kompaktową projekcję z jawnej native listy punktów, odczytując
metadane w sposób ograniczony i nie zbierając wszystkich wektorów w JSON DOM.
Oryginalne native pliki pozostają w prywatnym attempt output na dysku WSL.
Kanoniczna publikacja obejmuje oddzielną child directory `published/` w tym
samym attempcie: manifest v1, compact sweep v3, point metadata i dokładne
Zarr/binary payloady. Nie jest to osobny backend ani nowy model viewportu.

Wszystkie naukowe dane punktów są w CAS bundle i publicznej closure. Surowe
native sweep v1/v2 są redundantnymi kopiami wektorów i nie są referencjami
w nowym published manifeście; ich hashe zostają w source provenance. Nie
zastępuje się nimi brakującego payloadu ani nie obcina wektorów. Odtworzenie
CAS-only odbudowuje dokładnie published closure, z tymi samymi hashami.

Native Zarr v2: little-endian f64, tangent `[N,2,2]`, global xyz `[N,3,2]`,
real/imag interleaved. Aktualny writer ma też zgodnościowe `vector.bin` i
`vector_xyz.bin`; razem z chunks daje to 64*N bajtów na punkt tangent-only
lub 160*N z xyz, przed metadanymi i native JSON. Publisher zachowuje jawnie
referencjonowane pliki; nie zgaduje, że duplicate vector files są zbędne.
Pełny samowystarczalny wynik Zarr musi zachować frozen mesh, M0, mapę węzłów,
provenance, siatkę częstotliwości, odpowiedź i complex field payloady na WSL.

Existing immutable publisher `frequency_domain_artifact_generation.v2` jest
ponownie używany z jawną allow-listą; czytnik zachowuje obsługę historycznej v1.
Obecna native FR ścieżka zwraca pustą
listę auxiliary artifacts, dlatego nowe source tests muszą wykazać faktyczne
wywołanie generation commit, a nie tylko obecność manifestu w katalogu.

### 4.2. Dokładna mapa próbek do domeny

Native FR kompresuje węzły według `norm(M0)>1e-12`, w kolejności pełnego planu.
To ta sama funkcja, której używa builder native payloadu; nie wolno zastąpić
jej ponownym doborem węzłów z markerów ani wnioskowaniem z długości wektora.
Dla BuckyBall 52093 magnetic samples i 196126 węzłów pełnej domeny są różnymi
przestrzeniami indeksowania, mimo wspólnego źródła siatki.

Globalna closure zachowuje dokładną ordered `magnetic_node_indices`, byte
length i SHA mapy, source topology identity oraz hash M0. Każdy punkt wiąże
mapę i native sample count. API weryfikuje count, digest, zakres, unikalność
i source topology, a następnie emituje istniejące FMVP v5
`ExplicitNodeIndices`. Viewport obsługuje ten mapping; nie potrzeba ekspansji
na air nodes ani tworzenia osobnej siatki. Brak lub niezgodność dowodu mapy
zamyka binary response field z czytelnym błędem, zachowując odczyt widma.
Legacy count-only inference nie może certyfikować nowego accepted wyniku.

## 5. Wykonanie, Stop i recovery

Osobny `accepted_fem_frequency_response_worker` używa wspólnego lifecycle.
Przygotowany input i plan są zamrażane przed prywatnym attemptem i trwałym
started receipt. Runner otrzymuje jawne FrequencyDomainArtifactIdentity,
StageFemMeshIdentity, native urządzenie z lease i istniejący cancel callback.

Postęp oznacza frequency index, completed/total frequencies, iterację i
relative residual. Krok relaksacji oraz fizyczny czas nie są dopisywane.
Stop przed pierwszym punktem i w trakcie sweepu prowadzi do cancelled,
zachowuje partial artifacts i zwalnia lease po potwierdzonym wyjściu.
Nie publikuje complete index dla prefiksu sweepu.

Recovery rozróżnia started bez pewnego wyniku, cancelled, completed-before-ACK
i kompletną publikację. Nie uruchamia solvera ponownie po ambiguous side effect.
Dla completed ponownie sprawdza każdy digest, bound, port i physical case.
W razie utraty mutable kopii pozwala odtworzyć pliki z immutable CAS pod nowym
prywatnym rootem; nie przepisuje oryginalnego przyjętego runu.

## 6. API i przeglądarka

Publikacja korzysta z istniejącego frequency-domain manifest/readers, typed
resource hooks i binary fields; nie dodaje równoległego drzewa FEM ani endpointu
odczytującego dowolną ścieżkę hosta. Transportowe resource keys wylicza API.
Persisted dokumenty mają dokładnego ownera, bez current/run:current aliasów.

UI pokazuje `Driven Frequency Response`, tabelę sweepu i response fields tego
samego run/stage. Wzór odpowiedzi przy rezonansie nie jest certyfikowanym
modal_eigen. Reload i ponowne otwarcie muszą odczytać te same hashe z CAS.
Zapisany M0 można pokazać jako input state, z jego rzeczywistym zegarem;
nie jako nowy krok solvera częstotliwościowego.

## 7. Dowody wymagane przed BuckyBall

1. Kontrakty: fingerprint/layout/hash mismatch, air support, brak/duplikat portu,
   unsafe path, corrupt payload, aggregate RAM overflow i case mismatch odrzucone.
2. Managed fixed-backend runtime: mały CPU/GPU free Gamma case, rzeczywisty UUID
   i native engine, residual każdego punktu oraz brak GPU fallbacku.
3. Lifecycle: Stop przed pierwszym punktem i w sweepie, completion-before-ACK,
   CAS-only reopen bez ponownego Solve i bez nowego accepted state.
4. Publiczne zasoby i browser: zgodne session/run/stage, widoczny canvas,
   niezagubiony WebGL, niezerowy drawing buffer, spectrum/response field i reload.
5. BuckyBall: dokładny snapshot 25017 i frozen mesh, alpha=0.01, brak Relax,
   rzeczywisty GPU hybrid, zachowane widmo i pola na E w samowystarczalnym Zarr.

Weryfikacja numeryczna native solvera i COMSOL parity są oddzielne od integracji.
Przybliżony stan i gruba siatka 64 nm nie stanowią dowodu mesh convergence.
