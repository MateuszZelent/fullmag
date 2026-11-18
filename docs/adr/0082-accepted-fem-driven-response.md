# ADR 0082 — analiza FEM driven response w durable Workspace

- Status: propozycja; brak implementacji i kwalifikacji runtime.
- Data: 2026-11-17.
- Powiązania: ADR 0035, ADR 0045, ADR 0058, ADR 0060.
- Specyfikacja: [accepted FEM driven response v1](../specs/accepted-fem-driven-response-v1.md).

## Kontekst

BuckyBall ma zabezpieczony stan magnetyzacji, zgodną siatkę H1/P1 i jawne
żądanie FEM/GPU/double/strict. Native driven-response runner istnieje, lecz
Compute w Docker Workspace odrzuca FrequencyResponse jako
`accepted_gpu_scope_unsupported`. Adapter accepted FEM wymaga ponadto planu
`Fem` oraz `final_state`; preparer i materializacja wejścia również nie
obejmują planu `FemFrequencyResponse`. Poszerzenie samego warunku GPU nie
usuwa tych ograniczeń.

Użytkownik dopuścił stan przybliżony do pilota i polecił zakończyć relaksację.
To nie jest potwierdzenie równowagi ani kwalifikacja widma. Ten fakt musi
pozostać w provenance wejścia i każdego wyniku.

## Proponowana decyzja

1. Dodać osobny accepted producent analizy `FemFrequencyResponse`. Istniejący
   scheduler, claim, lease, Start, heartbeat, Stop, Completing i CAS pozostają
   właścicielem cyklu wykonania. Nie powstaje drugi backend ani kolejka.
2. Analiza konsumuje niezmienny snapshot i przygotowanie tej samej siatki.
   Nie wykonuje relaksacji i nie publikuje nowego accepted magnetization state.
   `final_state` oraz time-domain `device_resident` state receipt nie opisują
   harmonicznej odpowiedzi i nie mogą służyć jako substytut wyniku analizy.
3. Native runner i fizyka pozostają wspólne z dotychczasowym publicznym DSL
   i ProblemIR. Numeryka nie jest zmieniana przez adapter. Pierwszy zakres to
   free/Gamma, H1/P1, double/strict, provided equilibrium; GPU używa jawnego
   `gpu_operator_host_krylov`. CPU ma własny jawnie rozwiązany native solver.
   Nie dopuszcza się fallbacku wymuszonego GPU ani promocji modal_eigen.
4. Wynik ma jeden fizyczny `case_id`. Przed acceptance deklaruje się port
   indeksu `response` i deterministyczne porty `response-frequency-000000`,
   `response-frequency-000001`, itd. Każdy jest Artifact z wersjonowanym codec.
   Nie reinterpretujemy `case_id` jako numeru pliku ani częstotliwości:
   completed receipt wymaga jednego case i unikalnych portów.
5. Każdy punkt ma osobny bounded bundle metadanych i dokładnych bajtów jego
   payloadów. Indeks wiąże uporządkowane porty, częstotliwości i hashe bundle.
   Przed Start trzeba ograniczyć łączny RAM wyników i scratch, nie tylko
   pojedynczy plik. Publikacja całego deklarowanego zestawu jest atomowa przez
   istniejący output manifest. Nie stosuje się skanowania katalogu ani
   niejawnych plików poza closure.
   Istniejący native sweep v1/v2 duplikuje wektory w globalnym JSON. Publisher
   tworzy osobną kompaktową projekcję v3, zachowując stare native pliki jako
   source provenance i wszystkie pola w jawnych Zarr/binary payloadach.
6. GPU hybrid provenance jawnie rozróżnia operatory CUDA i host Krylov.
   Nie przedstawia tego jako `gpu_device_krylov` ani jako w pełni device-resident
   time evolution. Dowód urządzenia wiąże wykonanie z UUID z lease.
7. API używa istniejących zasobów frequency-domain oraz jednego drzewa Results
   dla `driven_response`. Transport kluczy i URL pozostaje po stronie API;
   hashed persisted dokumenty nie zawierają aliasów `current`.
8. Stop zachowuje częściowe dane pod właściwym attemptem, lecz nie publikuje
   ich jako kompletnego sweepu. Recovery weryfikuje CAS/receipt i nie powtarza
   Solve po niejednoznacznym wyniku.

## Obowiązki i weryfikacja

Plan prac rozdziela binding snapshotu i preparation, framing/codec wyników,
producent accepted, projekcję API oraz dowód działania GPU w przeglądarce.
Wymagane są regresje obcego mesh/layout/hash, uszkodzenia lub braku payloadu,
limitu całkowitego RAM, niezgodnego UUID, Stop przed pierwszym punktem i w
trakcie sweepu oraz recovery bez powtórzenia solvera.

Mały porównawczy CPU/GPU przypadek musi przejść tę samą native ścieżkę operatora.
Dopiero potem uruchamia się właściwy BuckyBall i sprawdza residual każdego
punktu. Green source tests, build lub wykrycie GPU nie kwalifikują fizyki ani
zgodności z COMSOL. Stan approximate pozostaje jawny.

## Wycofanie i zgodność

Do czasu pełnego adaptera zachowuje się obecne odrzucenie FrequencyResponse
w accepted Workspace. Nowe codeki mają oddzielne identyfikatory; stare state,
scalar i inspection pozostają niezmienione. Wycofanie zamyka wyłącznie nowy
zakres admission, zachowując accepted runs, snapshoty, pliki i receipty.
