# Metodyka audytu

Audyt obejmuje:

- wyszukiwanie właścicieli RHS LLG, integratorów, pól efektywnych, redukcji i kryteriów stopu;
- przegląd konwencji jednostek i stałej żyromagnetycznej;
- kontrolę projekcji `|m|=1`, rollback rejected step i termicznego RNG;
- identyfikację alokacji, kopii, synchronizacji, readbacków, assembly i tworzenia planów w hot path;
- rozdzielenie setup/cache od powtarzanego apply;
- analizę stiffness, norm błędu i tolerancji solverów pomocniczych;
- ocenę requested/resolved/executed backend i ryzyka silent fallback;
- przegląd dostępnych testów oraz definicję brakujących oracles i benchmarków.

Priorytety:

- **P0:** ryzyko błędnej fizyki, niejawnego backendu lub zasadniczego zablokowania GPU;
- **P1:** duże ryzyko błędu numerycznego albo dominującego kosztu w pętli;
- **P2:** problem utrzymaniowy, diagnostyczny lub optymalizacja drugiego rzędu.

Raport nie przypisuje przyspieszenia bez profilu na reprezentatywnym sprzęcie. Obecność kodu GPU nie jest traktowana jako dowód pełnej rezydencji urządzeniowej.
