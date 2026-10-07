# Odbior pilotow DE/BV: warstwy filmu i analityka

Kolektor scripts/collect_de_bv_thickness_comparison.py odczytuje terminalny
batch-control.json obserwatora #178. Wymaga wszystkich szesciu sukcesow
wrappera; nie generuje zaakceptowanego porownania z niepelnych wynikow.
W kazdym runie sprawdza request/result, job i zrodla modelu, odczytuje SI
z metadata, ponawia rzeczywista kontrole pionowego rozmiaru Tet4, walidacje
CSV/native spectrum oraz bound physical mode i jego pelny residual.
Profil jednorodny jest diagnostyka z masa P1, nie wyborem galezi z wykresu.
Zestaw kontroluje stale parametry, model, k, airbox, poziom siatki oraz
rzeczywiste pozycje x/y dla n=3/6/9. Rozne topologie z sa zamierzone.

Wyjscie: fullmag.de-bv.thickness-comparison.v1, qualification NOT VERIFIED.
Zawiera oryginalne czestotliwosci, analityke n=0 z rzeczywistych parametrow,
roznice procentowe, residua, profile oraz hashe wejsc i producenta.
Zgodnosc z otwartym jednorodnym filmem jest osobna ocena; przyblizenie n=0
pomija mieszanie modow grubosciowych i nie zastępuje airbox convergence.

## Weryfikacja

35 testow +38 podtestow wspolnej kontroli kolektor/profil/wrapper PASS.
Po dodaniu bledow fizycznego pola i nieprawidlowych residualow: 18 testow kolektora PASS.
Walidator mapy naukowej PASS. Fixture'y sa syntetyczne i nie stanowia dowodu FEM.
Historyczny rzeczywisty de-k25-l2-t6-eps10-ksp12 z #173 zostal odrzucony:
max vertical span 1e-08 m, target 1.66667e-09 m. Zachowano jego artefakty.

## Uruchomienie po odbiorze szesciu pilotow

python scripts/collect_de_bv_thickness_comparison.py <batch-control.json> <nowy-comparison.json>

JSON kolektora jest wejściem istniejacego audit_de_bv_poisson_weak.py.
compare_de_bv_mode_profiles.py porownuje rozne k na tej samej topologii;
nie wolno uruchamiac jego compare_profiles na roznych liczbach warstw.
Kolektor korzysta tylko z load_record i indywidualnej projekcji profilu.

#178 i #179 pozostaja queued; obserwator 45879 zyje. API zdrowe, worker
aktywny, accepting_jobs=true, slot zajmuje #177. Nie restartowano procesow,
nie zmieniono profili, nie kasowano storage. Jeszcze brak nowych czestotliwosci.


## Wykres i kontrola jego wejsc

plot_de_bv_thickness_comparison.py ponownie zbiera kazdy record z oryginalnych
runow i wymaga dokladnej zgodnosci z JSON kolektora. Zmiana wartosci analityki,
czestotliwosci, residualu albo profilu blokuje rysowanie.
Rysunek: 2 kolumny DE/BV, f(n_z) i roznica procentowa od n=0.
Nie jest dyspersja f(k), nie ma dopasowania ani ekstrapolacji.
PNG i PDF maja receipt z hashami wejsc, producenta i plikow wyjsciowych.
Nowy katalog wyjsciowy jest wymagany; istniejace wyniki nie sa nadpisywane.
46 testow +38 podtestow kolektor/wykres/profil/wrapper PASS.
Testy prezentacji sa syntetyczne. QA rzeczywistego wykresu pozostaje otwarte
do zakonczenia pilotow; nie opublikowano wykresu udajacego wynik FEM.

Komenda po uzyskaniu comparison.json:
python scripts/plot_de_bv_thickness_comparison.py <comparison.json> <nowy-katalog>

Kontener #177 zakonczyl sie kodem 0 o 14:02:10 UTC. O 14:22:54 UTC
kolejka nadal raportowala running, a koordynator byl aktywny (CPU ok. 86%).
Nie uznano tego za zakonczenie managed gate ani powod do restartu.
