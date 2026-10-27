"""Plot certified DE modes, separating native completion from UI publication."""
import argparse
import ast
import csv
import math
import hashlib
import json
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from finite_dirichlet_thin_film_oracle import finite_dirichlet_n0_frequency_hz

ROOT = Path(__file__).resolve().parents[1]

def published_owner(evidence):
    run, spectrum = evidence['run'], evidence['spectrum']
    manifest = evidence.get('manifest', {}).get('result_manifest')
    activation = evidence.get('activation')
    if activation is not None and activation.get('run_id') != run['run_id']:
        raise ValueError('Activation and result run owners differ')
    if run['status'] != 'completed' or not manifest:
        raise ValueError('Completed run and owner-bound manifest required')
    for resource in (manifest, spectrum):
        if (resource.get('status') != 'ready'
                or resource.get('run_id') != run['run_id']
                or resource.get('generation_status') != 'member_verified_owner_bound'
                or not resource.get('generation_id')
                or not resource.get('stage_id')):
            raise ValueError('Missing or conflicting published artifact owner')
    if (manifest['generation_id'] != spectrum['generation_id']
            or manifest['stage_id'] != spectrum['stage_id']):
        raise ValueError('Manifest and spectrum generations/stages differ')


def benchmark_parameters(script, mode):
    """Read this benchmark's literal inputs; never execute an input script."""
    tree = ast.parse(script.read_text())
    def one(values, label):
        if len(values) != 1:
            raise ValueError('Expected one literal benchmark input: ' + label)
        return values[0]
    def assigned(name):
        return ast.literal_eval(one([n.value for n in ast.walk(tree)
            if isinstance(n, ast.Assign) and any(ast.unparse(t) == name for t in n.targets)], name))
    def call(name):
        return one([n for n in ast.walk(tree) if isinstance(n, ast.Call)
                    and ast.unparse(n.func) == name], name)
    def keyword(node, name):
        return ast.literal_eval(one([v.value for v in node.keywords if v.arg == name], name))
    size = keyword(call('fm.Box'), 'size')
    universe = keyword(call('study.universe'), 'size')
    magnetization = ast.literal_eval(call('fm.init.UniformMagnetization').args[0])
    b_ext = tuple(ast.literal_eval(a) for a in call('study.b_ext').args)
    if magnetization != (1.0, 0.0, 0.0) or b_ext[1:] != (0.0, 0.0):
        raise ValueError('This DE reference requires M along x and field along x')
    if keyword(call('study.demag'), 'variant') != 'dirichlet':
        raise ValueError('Finite-airbox reference requires authored Dirichlet boundary')
    if size[:2] != universe[:2] or not 0 < size[2] < universe[2]:
        raise ValueError('Expected periodic film with an air padding only along z')
    gamma = keyword(call('study.solver'), 'gamma')
    if not math.isclose(gamma, mode['gamma0_rad_s_per_A_m'], rel_tol=1e-12):
        raise ValueError('Executed gamma differs from benchmark script')
    mu0 = mode['mu0_T_m_per_A']
    if not math.isclose(b_ext[0], mode['external_field_a_per_m'][0] * mu0, rel_tol=1e-12):
        raise ValueError('Executed field differs from benchmark script')
    params = dict(geometry='DE', bias_field_a_per_m=mode['external_field_a_per_m'][0],
        film_thickness_m=size[2], air_padding_each_side_m=(universe[2]-size[2])/2,
        exchange_stiffness_j_per_m=assigned('body.Aex'),
        saturation_magnetisation_a_per_m=assigned('body.Ms'),
        gamma0_rad_s_per_a_m=gamma, mu0_t_m_a=mu0)
    if any(not math.isfinite(v) or v <= 0 for k, v in params.items() if k != 'geometry'):
        raise ValueError('Benchmark parameters must be finite and positive')
    return params


def load_reference(path, params):
    """Bind the retained 1D reference to its finite-airbox companion model."""
    reference = {}
    with path.open() as stream:
        for row in csv.DictReader(stream):
            k = float(row['k_y_rad_per_um'])
            expected = finite_dirichlet_n0_frequency_hz(k_rad_m=k * 1e6, **params)
            recorded = float(row['finite_dirichlet_n0_hz'])
            value = float(row['open_air_1d_basis16_hz'])
            if (k in reference or not math.isfinite(value) or value <= 0
                    or not math.isclose(expected, recorded, rel_tol=1e-10, abs_tol=1e-3)):
                raise ValueError('Stored 1D reference does not match benchmark physics')
            reference[k] = value
    return reference


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
        if (not r['full_descriptor_certified']
                or not math.isfinite(r['eps_full']) or r['eps_full'] < 0
                or not math.isfinite(r['certification_tolerance']) or r['certification_tolerance'] <= 0
                or r['eps_full'] > r['certification_tolerance']):
            raise ValueError('Uncertified full descriptor')
        if not math.isfinite(m['frequency_hz']) or m['frequency_hz'] <= 0:
            raise ValueError('Frequency must be finite and positive')
        if not m['mode_field_available'] or m['assembly_kind'] != 'mfem_weak_form_shared_domain':
            raise ValueError('Missing published shared-domain mode')
        if m['k_vector'][0] != 0 or m['k_vector'][2] != 0:
            raise ValueError('This plot expects DE along ky')
        rows.append(dict(ky_rad_per_um=m['k_vector'][1]/1e6, frequency_hz=m['frequency_hz'],
                         residual=r['eps_full'], run_id=run_id, publication_status=publication,
                         sample_index=sample['sample_index'], raw_mode_index=0))
    return evidence, rows

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', type=Path, action='append', help='Current API evidence; repeat for separate runs')
    parser.add_argument('--benchmark-script', type=Path, help='Exact authored script for current API evidence')
    parser.add_argument('--output-dir', type=Path)
    args = parser.parse_args()
    if bool(args.evidence) != bool(args.benchmark_script):
        parser.error('--evidence and --benchmark-script must be supplied together')
    paths=args.evidence or [ROOT/'docs/audits/2026-10-27-eigensolve-gamma-after-docker.evidence.json',
                           ROOT/'docs/audits/2026-10-27-eigensolve-path-session-mismatch.evidence.json']
    loaded=[load_samples(p) for p in paths]
    current_api = bool(args.evidence)
    if current_api:
        script_digest = hashlib.sha256(args.benchmark_script.read_bytes()).hexdigest()
        for evidence, _ in loaded:
            published_owner(evidence)
            if evidence.get('activation', {}).get('source_sha256') != script_digest:
                raise ValueError('Activation does not bind the exact benchmark script')
    rows=sorted([r for _, samples in loaded for r in samples], key=lambda r:r['ky_rad_per_um'])
    expected=[-25,-20,-15,-10,-7,-5,-2,0,2,5,7,10,15,20,25]
    if [r['ky_rad_per_um'] for r in rows] != expected:
        raise ValueError('Expected 15 distinct signed samples including Gamma')
    m=loaded[0][0]['spectrum']['payload']['samples'][0]['modes'][0]
    params=dict(geometry='DE',bias_field_a_per_m=m['external_field_a_per_m'][0],
                film_thickness_m=10e-9,air_padding_each_side_m=2e-6,
                exchange_stiffness_j_per_m=13e-12,saturation_magnetisation_a_per_m=800000.,
                gamma0_rad_s_per_a_m=m['gamma0_rad_s_per_A_m'],mu0_t_m_a=m['mu0_T_m_per_A'])
    if current_api:
        params=benchmark_parameters(args.benchmark_script,m)
        for evidence, _ in loaded:
            for sample in evidence['spectrum']['payload']['samples']:
                for mode in sample['modes']:
                    if mode['raw_mode_index'] == 0 and benchmark_parameters(args.benchmark_script, mode) != params:
                        raise ValueError('Executed physical parameters differ across samples')
    reference_path=ROOT/'docs/raports/2026-10-04-de-signed15-runtime.csv'
    reference = load_reference(reference_path, params)
    for row in rows:
        row['analytic_n0_finite_airbox_hz']=finite_dirichlet_n0_frequency_hz(k_rad_m=row['ky_rad_per_um']*1e6,**params)
        row['reference_1d_open_air_hz']=reference[row['ky_rad_per_um']]
        row['error_n0_percent']=100*(row['frequency_hz']/row['analytic_n0_finite_airbox_hz']-1)
        row['error_1d_percent']=100*(row['frequency_hz']/row['reference_1d_open_air_hz']-1)
    out=args.output_dir or ROOT/'docs/raports/assets/de-native-completed-20261027';out.mkdir(parents=True,exist_ok=True)
    ks=[v/10 for v in range(-250,251)]
    fig,(ax,err)=plt.subplots(2,1,figsize=(10,7),sharex=True,layout='constrained',gridspec_kw={'height_ratios':[3,1]})
    ax.plot(ks,[finite_dirichlet_n0_frequency_hz(k_rad_m=k*1e6,**params)/1e9 for k in ks],label='Analityka n=0, skończony airbox Dirichleta',color='#17638d')
    ax.plot(expected,[reference[k]/1e9 for k in expected],label='Referencja 1D open-air, basis16 (zachowana tabela)',color='black',linestyle='--')
    ax.scatter(expected,[r['frequency_hz']/1e9 for r in rows],label=('FEM: 15 punktów opublikowanych przez API' if current_api else 'FEM: 15 obliczonych punktów; publikacja nonzero-k do UI zablokowana'),color='#ca431c',s=35,zorder=5)
    title = (f"DE: M ∥ x, k ∥ y; film {params['film_thickness_m']*1e9:g} nm, "
             f"B = {params['bias_field_a_per_m']*params['mu0_t_m_a']:g} T")
    ax.set(ylabel='Częstotliwość [GHz]',title=title,xlim=(-26,26));ax.legend(fontsize=9);ax.grid(alpha=.25)
    err.plot(expected,[r['error_n0_percent'] for r in rows],'o-',label='względem n=0 finite-airbox',markersize=4)
    err.plot(expected,[r['error_1d_percent'] for r in rows],'s--',label='względem 1D open-air',markersize=4)
    err.axhline(0,color='black',linewidth=.5);err.set(xlabel='ky [rad/µm]',ylabel='Różnica [%]');err.grid(alpha=.25);err.legend(fontsize=8)
    fig.supxlabel(('Wyniki API; raw mode 0. Kompletność widma, tracking i zbieżność NOT VERIFIED.' if current_api else 'Γ: wynik API. Nonzero-k: pakiet solvera succeeded; odrzucony przez UI. Kompletność i zbieżność NOT VERIFIED.'),fontsize=8)
    for ext in ('png','pdf'):fig.savefig(out/f'de-native-completed-dispersion.{ext}',dpi=180)
    plt.close(fig)
    with (out/'samples.csv').open('w') as f:
        writer=csv.DictWriter(f,fieldnames=list(rows[0]));writer.writeheader();writer.writerows(rows)
    provenance=dict(evidence=[dict(path=str(p.resolve().relative_to(ROOT)) if p.resolve().is_relative_to(ROOT) else str(p.resolve()),sha256=hashlib.sha256(p.read_bytes()).hexdigest()) for p in paths],
                    reference_sha256=hashlib.sha256(reference_path.read_bytes()).hexdigest(),parameters=params,samples=rows,
                    scope=('Current API completed/published; raw mode 0, no completeness or tracking claim' if current_api else 'Gamma API completed; signed14 native tasks succeeded but API publication rejected; raw mode 0, no completeness or tracking claim'),qualification='NOT VERIFIED')
    if current_api:
        provenance['benchmark_script'] = dict(path=str(args.benchmark_script.resolve()), sha256=script_digest)
    (out/'provenance.json').write_text(json.dumps(provenance,indent=2)+'\n')
    print(out)

if __name__=='__main__':main()
