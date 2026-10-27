"""Plot certified DE modes, separating native completion from UI publication."""
import csv
import hashlib
import json
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from finite_dirichlet_thin_film_oracle import finite_dirichlet_n0_frequency_hz

ROOT = Path(__file__).resolve().parents[1]

def load_samples(path):
    evidence = json.loads(path.read_text())
    if 'run_catalog' in evidence:
        catalog = evidence['run_catalog']
        if not catalog['tasks'] or any(t['lifecycle'] != 'succeeded' for t in catalog['tasks']):
            raise ValueError('Native tasks must all have succeeded')
        if evidence['manifest']['run_id'] != catalog['run_id']:
            raise ValueError('Native manifest and catalog run owners differ')
        run_id = catalog['run_id']
        samples = evidence['spectrum']['samples']
        publication = 'native generation completed; UI rejected session identity'
    else:
        if evidence['run']['status'] != 'completed' or evidence['spectrum']['status'] != 'ready':
            raise ValueError('API evidence must be completed and published')
        run_id = evidence['run']['run_id']
        samples = evidence['spectrum']['payload']['samples']
        publication = 'API published'
    rows = []
    for sample in samples:
        modes = [m for m in sample['modes'] if m['raw_mode_index'] == 0]
        if len(modes) != 1:
            raise ValueError('Expected exactly one explicitly selected raw mode 0')
        m = modes[0]
        r = m['block_residuals']
        if not r['full_descriptor_certified'] or r['eps_full'] > r['certification_tolerance']:
            raise ValueError('Uncertified full descriptor')
        if not m['mode_field_available'] or m['assembly_kind'] != 'mfem_weak_form_shared_domain':
            raise ValueError('Missing published shared-domain mode')
        if m['k_vector'][0] != 0 or m['k_vector'][2] != 0:
            raise ValueError('This plot expects DE along ky')
        rows.append(dict(ky_rad_per_um=m['k_vector'][1]/1e6, frequency_hz=m['frequency_hz'],
                         residual=r['eps_full'], run_id=run_id, publication_status=publication,
                         sample_index=sample['sample_index'], raw_mode_index=0))
    return evidence, rows

def main():
    paths=[ROOT/'docs/audits/2026-10-27-eigensolve-gamma-after-docker.evidence.json',
           ROOT/'docs/audits/2026-10-27-eigensolve-path-session-mismatch.evidence.json']
    loaded=[load_samples(p) for p in paths]
    rows=sorted([r for _, samples in loaded for r in samples], key=lambda r:r['ky_rad_per_um'])
    expected=[-25,-20,-15,-10,-7,-5,-2,0,2,5,7,10,15,20,25]
    if [r['ky_rad_per_um'] for r in rows] != expected:
        raise ValueError('Expected 15 distinct signed samples including Gamma')
    m=loaded[0][0]['spectrum']['payload']['samples'][0]['modes'][0]
    params=dict(geometry='DE',bias_field_a_per_m=m['external_field_a_per_m'][0],
                film_thickness_m=10e-9,air_padding_each_side_m=2e-6,
                exchange_stiffness_j_per_m=13e-12,saturation_magnetisation_a_per_m=800000.,
                gamma0_rad_s_per_a_m=m['gamma0_rad_s_per_A_m'],mu0_t_m_a=m['mu0_T_m_per_A'])
    reference_path=ROOT/'docs/raports/2026-10-04-de-signed15-runtime.csv'
    with reference_path.open() as stream:
        reference={float(r['k_y_rad_per_um']):float(r['open_air_1d_basis16_hz']) for r in csv.DictReader(stream)}
    for row in rows:
        row['analytic_n0_finite_airbox_hz']=finite_dirichlet_n0_frequency_hz(k_rad_m=row['ky_rad_per_um']*1e6,**params)
        row['reference_1d_open_air_hz']=reference[row['ky_rad_per_um']]
        row['error_n0_percent']=100*(row['frequency_hz']/row['analytic_n0_finite_airbox_hz']-1)
        row['error_1d_percent']=100*(row['frequency_hz']/row['reference_1d_open_air_hz']-1)
    out=ROOT/'docs/raports/assets/de-native-completed-20261027';out.mkdir(parents=True,exist_ok=True)
    ks=[v/10 for v in range(-250,251)]
    fig,(ax,err)=plt.subplots(2,1,figsize=(10,7),sharex=True,layout='constrained',gridspec_kw={'height_ratios':[3,1]})
    ax.plot(ks,[finite_dirichlet_n0_frequency_hz(k_rad_m=k*1e6,**params)/1e9 for k in ks],label='Analityka n=0, skończony airbox Dirichleta',color='#17638d')
    ax.plot(expected,[reference[k]/1e9 for k in expected],label='Referencja 1D open-air, basis16 (zachowana tabela)',color='black',linestyle='--')
    ax.scatter(expected,[r['frequency_hz']/1e9 for r in rows],label='FEM: 15 obliczonych punktów; publikacja nonzero-k do UI zablokowana',color='#ca431c',s=35,zorder=5)
    ax.set(ylabel='Częstotliwość [GHz]',title='DE: M ∥ x, k ∥ y; film 10 nm, B = 0,1 T',xlim=(-26,26));ax.legend(fontsize=9);ax.grid(alpha=.25)
    err.plot(expected,[r['error_n0_percent'] for r in rows],'o-',label='względem n=0 finite-airbox',markersize=4)
    err.plot(expected,[r['error_1d_percent'] for r in rows],'s--',label='względem 1D open-air',markersize=4)
    err.axhline(0,color='black',linewidth=.5);err.set(xlabel='ky [rad/µm]',ylabel='Różnica [%]');err.grid(alpha=.25);err.legend(fontsize=8)
    fig.supxlabel('Γ: wynik API. Nonzero-k: pakiet solvera succeeded; odrzucony przez UI. Kompletność i zbieżność NOT VERIFIED.',fontsize=8)
    for ext in ('png','pdf'):fig.savefig(out/f'de-native-completed-dispersion.{ext}',dpi=180)
    plt.close(fig)
    with (out/'samples.csv').open('w') as f:
        writer=csv.DictWriter(f,fieldnames=list(rows[0]));writer.writeheader();writer.writerows(rows)
    provenance=dict(evidence=[dict(path=str(p.relative_to(ROOT)),sha256=hashlib.sha256(p.read_bytes()).hexdigest()) for p in paths],
                    reference_sha256=hashlib.sha256(reference_path.read_bytes()).hexdigest(),parameters=params,samples=rows,
                    scope='Gamma API completed; signed14 native tasks succeeded but API publication rejected; raw mode 0, no completeness or tracking claim',qualification='NOT VERIFIED')
    (out/'provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
    print(out)

if __name__=='__main__':main()
