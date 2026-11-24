# Pierwszy kontrolny Run LLG z parametrami modelu Sushruth2020

Raport historyczny z 04.11.2026; podane liczniki i oczekujące decyzje opisują
wyłącznie tamtą chwilę. Aktualny stan: [plan wykonania](2026-10-11-antenna-transport-e2e-implementation.md).

**Wykonano prawdziwy Run Fullmaga i potwierdzono jednorodną precesję k=0.**
To kontrola równania LLG, nie odtworzenie propagacji fal spinowych, odpowiedzi
anteny lub Fig.3. Nie używa ona zachowanego pola anteny.

## Wynik

| Kontrola | Wynik | Kryterium ustalone przed Run |
|---|---:|---:|
| Zaakceptowane kroki / czas | 20000 /2ns | Pełny horyzont2ns |
| Próbki odczytanej trajektorii | 2001 | co najmniej1000 |
| Największy błąd wektora m | 1,59e−13 | <=1e−7 |
| Największy defekt normy m | 2,22e−16 | <=1e−10 |
| Częstotliwość z zapisanej fazy | 7,499250074960GHz | Wzorzec7,499250074993GHz; błąd względny<=1e−5 |
| Względny błąd częstotliwości | 4,35e−12 | <=1e−5 |
| Względny błąd tempa tłumienia | 1,92e−11 | <=1e−3 |

Wszystkie kryteria tej jednej kontroli przeszły. Nie jest to globalna
kwalifikacja backendu lub wszystkich integratorów. W archiwum nie zmieniono
scientific_assessment: pozostaje unassessed; osobny raport opisuje powyższy
wynik. Częstotliwość dokładnego tłumionego bieguna różni się od7,5GHz
bez tłumienia; nie utożsamiano jej ze znacznikiem Fig.3.

## Co faktycznie policzono

Publiczny skrypt `examples/fdm_sushruth_2020_k0_free_precession.py` deklaruje
FDM CPU, double, strict, jedną komórkę20nm, mu0Ms0,89T, alfa0,01,
pole efektywne0,25T wzdłuż+z i gamma_H=mu0*2pi*30GHz/T. RK4 ma stały
krok1e−13s. Małe początkowe wychylenie mx0=0,001 uruchamia precesję.
Demag, wymiana, anizotropia i temperatura są wyłączone. Dodatnie Aex jest
wymaganą wartością materiału API, ale wyłączona wymiana nie używa go w RHS.

Nie jest to skończona próbka Co/Ni. Pole0,25T jest całym polem efektywnym
kontroli, a nie próbą odgadnięcia pola przyłożonego eksperymentu. Wykorzystano
istniejący dokładny `scripts/antenna_macrospin_oracle.py::macrospin_from_field_impulse`;
nie dodano drugiego solvera lub drugiego wzorca. Równanie i mapowanie
parametrów są w nocie0951, sekcja sushruth-k0-runtime-control, z odwołaniem
do kanonicznego kontraktu LLG0960.

## Droga wykonania i zapis

1.3/3 interpretowane kontrole publicznego loadera i round-trip PASS.
2.Publiczny runtime-free projekt i CLI prepare-only zakończyły się poprawnie.
3.Istniejące `just docker-dev-submit-accepted` wysłało żądanie dokładnie raz.
  Klient przekroczył30s; GET potwierdził ten sam run i fingerprint.
4.Istniejące `just docker-dev-materialize-accepted` wykonało wyłącznie
  brakującą materializację. Nadzorowany worker zakończył Run jako succeeded.
5.Odczytano SolutionSet przez API, sprawdzono hashe stanu CAS i odczytano
  zachowaną tabelę workera. Jej koniec zgadza się ze stanem CAS.

Tabela jest trwale zachowana, ale nie figuruje jako osobny artefakt w
katalogu SolutionSet. Odczyt pełnej trajektorii z tego katalogu/UI nie
został dowiedziony. To konkretna luka dalszej integracji wyników, nie brak
obliczeń. Nie uruchamiano symulacji ponownie w celu odczytu tabeli.

Sesja i scena anteny na3203 pozostały bez zmian; nie było restartu lub
nowego buildu. Wykonany backend to cpu_reference, integrator rk4, precyzja
double, brak fallbacku. Minimum zasobów1CPU/2GiB nie było limitem: istniejący
scheduler przydzielił slot3CPU/5,25GiB w dotychczasowym kontenerze. Szczyt
RAM samego native Run nie został zmierzony. Analiza tabeli miała peak33,44MB
i osobny limit2GiB; nie jest to zużycie solvera.

## Co to zmienia dla reprodukcji pracy

Mamy pierwszy sprawdzony fragment dynamiki w rzeczywistym Fullmagu:
częstotliwość i tłumienie jednorodnego stopnia swobody zgadzają się z
równaniem przy zadanych parametrach TableI. To mocniejszy dowód niż sam
wykres niezależnego wzorca Python, ale nie potwierdza R/T, skończonego k,
prądu3D, projekcji lub wzbudzenia fal przez antenę. Rozbieżność Fig.3
pozostaje nierozstrzygnięta.

Pełny zakres E0–E12 pozostaje aktywny. Nowy eksperyment GSG: V/J/H0/3,
niezależne kontrole H0/9, nowy build0/1; patch metadanych4581df0a…
nie został zastosowany i czeka na wcześniej wysłaną decyzję.

## Tożsamości i dowody

- Run: `run-968b1e61c20ea61f582dfd5f0b3bba9660b44411337bc14e06aaa1fc945085a3`.
- Projekt: `project-1aa2f56967dd4603bb23c7c90554f47a`.
- Task: `task-2ecd96dd82ad2924685b3fa6fd2a81c9ec55c7bf4a3eadfdcfaccdc81a54b833`.
- Attempt: `attempt-d33167eec4b841609bff3a731de39e31`, epoch1.
- Request SHA256: `a69d86e193ebca93c0ffefee4f78db054a434d154bb8953e4315a22e882abd5c`.
- Skrypt SHA256: `c6a0546c943c23859558947ccd8d9021836068c8c70c53c05a0b07d408e5c0ac`.
- Runtime snapshot: `3422d160ec334bbd58cc039961e7a237a1cd84a522711ec3b48849ee567b8226`.
- Tabela SHA256: `ea3ec49cbdc388cdef1f6a04d4f0d4631a9c2ddd773dbde716dcdd02f52c006e`.
- SolutionSet: `solution-1eda9f513ac87e154c38efef876e55254d1acbfea676a3e476ebc9a7e381f544`, rev2.

Dowody w prywatnym control volume grupy:
`verification/sushruth-k0-runtime-control-20261104/`. Szczególnie:
`prepare-only.json`, `pre-submit-validation.json`, `accepted-run-latest.json`,
`trajectory-verification.json`, `retained-trajectory.csv`,
`retained-trajectory-schema.json` i `worker-completion-receipt.json`.
Zachowano także wcześniejsze nieudane próby testów authoringu i analizę
samego stanu końcowego; nie pomylono ich z odbiorem całej trajektorii.
