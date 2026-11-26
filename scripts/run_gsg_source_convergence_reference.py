"""One approved nine-point RT0 reference series over immutable saved results.

This interpreted diagnostic never calls Solve or publishes a qualified basis.
The managed host recipe pins the current group and supplies a hashed request.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import resource
import signal
import stat
import struct
import sys
import time
from urllib.parse import quote

from verify_archived_solution_http import Client, MAX_BINARY, MAX_METADATA, require, verify_slice

CONTROL = Path('/opt/fullmag/control')
ARCHIVE = Path('/opt/fullmag/retained-results/antenna/session-store')
ATTEMPT = CONTROL / 'verification/gsg-source-convergence-reference-20261105/one-approved-attempt'
PREPARED = CONTROL / ('verification/retained-current-h-only-20261102/accepted-store-v2/'
    'producer-dispatch-build/lock-scope-fix-build/work-budget-preflight-20261103/'
    'public-gsg-universe-275-01-version-fixed/gsg-convergence-inputs-20261103/prepared-v2')
EXPECTATIONS = CONTROL / 'verification/readonly-result-archive-20261105/http-expectations.json'
EXPECTATIONS_SHA = '10f1fc6f38deb0e1fda636184ba6057dbe545329b1aad3e00fcf968c3e63bbc9'
AUTHORIZATION_SHA = '4b8e16f31b6ffdce1b4d17b991a219170e95bd97e9ae15dbf502b36a2fab58ae'
CASES = (
    ('100nm', 14299, 'a4c02f09dd0200974ec1b0279e61272406159e53eaa28417a87e1f38013e4c32'),
    ('75nm', 25516, 'd70024ed4b4085c69e073bed81f6da67b6499c8e75bda1ea169a507154b02b40'),
    ('50nm', 72911, '36eac68c08f9f5ef15f4d0d2ccae62eb35e67c6496b39702f359201e2d84fed2'),
)
INDICES = (0, 8, 16)
KEPT = {'cells', 'vertex_xyz', 'stable_vertex_ids', 'conductivity', 'j_local_raw', 'j_center_raw',
        'sample_xyz', 'sample_cells', 'h_raw', 'v_raw'}


def checked(path, digest, maximum):
    require(path.resolve(strict=True) == path, 'noncanonical or linked input')
    before = path.stat()
    require(stat.S_ISREG(before.st_mode) and 0 < before.st_size <= maximum, 'input size/type differs')
    raw = path.read_bytes()
    after = path.stat()
    require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
            (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns), 'input changed while reading')
    require(hashlib.sha256(raw).hexdigest() == digest, 'input digest differs: ' + str(path))
    return raw


def decode_bundle(raw):
    """Check the existing FMACLB01 closure; retain only reference input arrays."""
    require(20 <= len(raw) <= 512 * 1024 * 1024 and raw[:8] == b'FMACLB01', 'bundle framing differs')
    length, count = struct.unpack_from('<QI', raw, 8)
    require(0 < length <= 16 * 1024 * 1024 and 0 < count <= 256 and 20 + length <= len(raw), 'bundle bounds differ')
    manifest = json.loads(raw[20:20 + length])
    require(manifest['schema_version'] == 'antenna_field_solution.v2' and
            manifest['status'] == 'inspection_only', 'bundle family differs')
    descriptors = manifest['payloads']
    require(len(descriptors) == count and KEPT <= descriptors.keys(), 'bundle closure differs')
    expected = {v['path']: (k, v) for k, v in descriptors.items()}
    require(len(expected) == count, 'duplicate descriptor path')
    offset, previous, retained = 20 + length, '', {}
    for _ in range(count):
        require(offset + 2 <= len(raw), 'truncated payload path')
        n = struct.unpack_from('<H', raw, offset)[0]; offset += 2
        require(0 < n <= 1024 and offset + n + 8 <= len(raw), 'payload path bound differs')
        path = raw[offset:offset + n].decode('ascii'); offset += n
        size = struct.unpack_from('<Q', raw, offset)[0]; offset += 8
        require(path > previous and path in expected and offset + size <= len(raw), 'unordered, foreign or truncated payload')
        key, descriptor = expected[path]
        require(path == f"antenna/field_solutions/{manifest['solution_id']}/{key}.bin" and
                size == descriptor['byte_length'] and size > 0, 'noncanonical payload descriptor')
        value = memoryview(raw)[offset:offset + size]
        require(hashlib.sha256(value).hexdigest() == descriptor['sha256'], 'payload digest differs')
        if key in KEPT:
            retained[key] = bytes(value)
        offset += size; previous = path
    require(offset == len(raw) and len(retained) == len(KEPT), 'incomplete or trailing bundle')
    return manifest, retained


def vector_bytes(rows):
    return b''.join(struct.pack('<3d', *row) for row in rows)


def verify_carriers(ir, manifest, data, expected_cells, targets):
    current = ir['current_modules'][0]
    source = current['conservative_current_source']
    assets = ir['geometry_assets']
    mesh = next(a['mesh'] for a in assets['fem_mesh_assets'] if a['geometry_name'] == source['geometry_id'])
    target_mesh = assets['fem_domain_mesh_asset']['mesh']
    ids = source['stable_vertex_ids']
    require(manifest['cell_count'] == expected_cells and manifest['vertex_count'] == len(ids), 'source counts differ')
    require(manifest['source_object_id'] == source['object_id'] and
            manifest['current_transport_id'] == current['name'] and manifest['full_closure'] == source['closure'],
            'source owner or closure differs')
    require(all(manifest['requested_intent'][k] == source[k] for k in
                ('mesh_digest', 'materials_digest', 'authored_input_digest')), 'requested source identity differs')
    require(data['stable_vertex_ids'] == struct.pack('<' + 'Q' * len(ids), *ids) and
            data['vertex_xyz'] == vector_bytes(mesh['nodes']), 'source nodes differ from frozen IR')
    require(data['sample_xyz'] == vector_bytes(target_mesh['nodes']) and
            data['sample_cells'] == struct.pack('<' + 'I' * len(target_mesh['cells']['nodes']), *target_mesh['cells']['nodes']),
            'sampling carrier differs from frozen IR')
    require(len(target_mesh['nodes']) == manifest['target_count'] == 20 and
            all(struct.pack('<3d', *target_mesh['nodes'][i]) == struct.pack('<3d', *target)
                for i, target in zip(INDICES, targets)), 'registered target coordinates differ')
    require(len(data['cells']) == expected_cells * 280 and len(data['j_local_raw']) == expected_cells * 96 and
            len(data['j_center_raw']) == expected_cells * 24, 'full RT0 carrier lengths differ')
    connectivity = mesh['cells']
    require(connectivity['types'] == ['tet4'] * expected_cells and
            connectivity['offsets'] == list(range(0, 4 * expected_cells + 1, 4)), 'source Tet4 layout differs')
    by_id = dict(zip(ids, mesh['nodes']))
    for index, row in enumerate(struct.iter_unpack('<5Q30d', data['cells'])):
        require(row[0] == index and all(math.isfinite(v) for v in row[5:]), 'nonfinite or foreign source cell')
        local_ids = [ids[j] for j in connectivity['nodes'][4 * index:4 * index + 4]]
        require(sorted(row[1:5]) == sorted(local_ids), 'source cell differs from frozen IR')
        require(all(struct.pack('<3d', *row[5+3*j:8+3*j]) == struct.pack('<3d', *by_id[vertex])
                    for j, vertex in enumerate(row[1:5])), 'cell-local coordinates differ')
        require(struct.pack('<12d', *row[17:29]) == data['j_local_raw'][index*96:(index+1)*96] and
                struct.pack('<3d', *row[32:35]) == data['j_center_raw'][index*24:(index+1)*24], 'RT0 local current differs')
    require(all(v[0] == 35000000. for v in struct.iter_unpack('<d', data['conductivity'])) and
            len(data['conductivity']) == expected_cells * 8 and
            all(item['material']['sigma_Spm'] == 35000000. for item in current['materials']), 'conductivity differs')
    return {'cells': expected_cells, 'source_current_a': manifest['source']['source_current_a'],
            'source_state_sha256': manifest['source']['accepted_source_state_digest'],
            'prepared_execution_sha256': manifest['source']['prepared_execution_digest'],
            'payloads': {key: manifest['payloads'][key] for key in sorted(KEPT)}}


def load_case(number, client, expectations, source_irs):
    label, cell_count, bundle_sha = CASES[number]
    ir = json.loads(checked(PREPARED / f'gsg_convergence_{label}.problem-ir.json', source_irs[number], 12 * 1024 * 1024))
    manifest, data = decode_bundle(checked(ARCHIVE / 'objects/sha256' / bundle_sha, bundle_sha, 512 * 1024 * 1024))
    from antenna_gsg_convergence_reference import TARGETS_M
    proof = verify_carriers(ir, manifest, data, cell_count, TARGETS_M)
    run = next(r for r in expectations['runs'] if r['label'] == label)
    root = '/v2/persistence/projects/' + quote(run['project_id'], safe='') + '/runs/' + quote(run['run_id'], safe='')
    value = client.json(root)
    require(value['payload_fingerprint'] == run['payload_fingerprint'] and value['run_id'] == run['run_id'] and
            value['project_id'] == run['project_id'] and [t['lifecycle'] for t in value['tasks']] == ['succeeded'],
            'accepted source run differs')
    revision = root + '/solution-sets/' + quote(run['solution_set_id'], safe='') + '/revisions/' + run['revision']
    require(client.json(revision)['execution_status'] == 'succeeded', 'saved source solution did not succeed')
    for expected in run['datasets']:
        key = {'field:V_electric': 'v_raw', 'field:J_charge': 'j_local_raw', 'field:H_ant': 'h_raw'}[expected['field_id']]
        require(hashlib.sha256(data[key]).hexdigest() == expected['payload_sha256'], 'CAS current/field differs from accepted tensor')
        artifact = revision + '/members/' + quote(expected['member_id'], safe='') + '/artifacts/' + quote(expected['artifact_id'], safe='')
        query = {k: expected[k] for k in ('dataset_id', 'dataset_revision', 'sample_id', 'item_id', 'field_id')}
        query.update(schema_version='1.0.0', expected_manifest_object_ref=expected['manifest_object_ref'],
                     element_offset='0', element_count=str(expected['elements']), max_response_bytes=str(MAX_BINARY))
        verify_slice(client.get(artifact + '/materialized-dataset/slice', query, maximum=MAX_BINARY + MAX_METADATA + 12), expected, run)
        if key == 'h_raw':
            geometry = client.json(artifact + '/saved-field-geometry')
            require(geometry['source']['tensor_object_ref'] == expected['source']['tensor_object_ref'] and
                    int(geometry['node_count']) == 20, 'canonical cold geometry/source verification differs')
    proof.update(label=label, bundle_sha256=bundle_sha, ir_sha256=source_irs[number], run_id=run['run_id'],
                 solution_set_id=run['solution_set_id'], revision=run['revision'])
    return data, proof


def write(name, value):
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False, indent=2).encode()
    target = ATTEMPT / name
    temporary = ATTEMPT / (name + '.tmp')
    with temporary.open('wb') as stream:
        stream.write(raw); stream.flush(); os.fsync(stream.fileno())
    os.replace(temporary, target)
    sync_directory(ATTEMPT)


def sync_directory(path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def claim_once(request_sha256):
    with (ATTEMPT / 'started.json').open('x') as stream:
        json.dump({'pid': os.getpid(), 'process_start_token': Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()[19],
                   'request_sha256': request_sha256, 'affinity': sorted(os.sched_getaffinity(0))}, stream)
        stream.flush(); os.fsync(stream.fileno())
    sync_directory(ATTEMPT)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--request-sha256', required=True)
    parser.add_argument('--preflight', action='store_true')
    args = parser.parse_args()
    request_raw = checked(Path(__file__).parent.parent / 'request.json', args.request_sha256, MAX_METADATA)
    request = json.loads(request_raw)
    require(request['schema'] == 'fullmag.gsg-source-convergence-reference-request.v1' and
            request['reference_checks'] == 9 and request['automatic_retries'] == 0, 'reference request differs')
    require(set(request['tools']) == {'antenna_gsg_convergence_reference.py', 'antenna_rt0_surface_oracle.py',
            'antenna_triangle_surface_oracle.py', 'verify_archived_solution_http.py'}, 'reference tool closure differs')
    for name, digest in request['tools'].items():
        require(Path(name).name == name and name.endswith('.py'), 'invalid reference tool name')
        checked(Path(__file__).parent / name, digest, MAX_METADATA)
    checked(Path(__file__), request['driver_sha256'], MAX_METADATA)
    wheel = Path(request['wheel'])
    require(wheel.is_relative_to(CONTROL / 'verification') and wheel.name == 'mpmath-1.3.0-py3-none-any.whl', 'wheel location differs')
    checked(wheel, 'a0b2b9fe80bbcd81a6647ff13108738cfb482d481d826cc0e02f5b35e5c88d2c', 2 * MAX_METADATA)
    sys.path.insert(0, str(wheel))
    import antenna_gsg_convergence_reference as gsg
    import antenna_triangle_surface_oracle as triangle
    authorization = json.loads(checked(PREPARED / 'user-authorization.json', AUTHORIZATION_SHA, MAX_METADATA))
    require(authorization['proposal_document_sha256'] == gsg.PROPOSAL_SHA256 == request['proposal_sha256'] and
            authorization['independent_h_checks'] == 9 and authorization['maximum_reference_seconds'] == 43200 and
            authorization['maximum_reference_ram_bytes'] == 2147483648, 'authorization differs')
    expectations = json.loads(checked(EXPECTATIONS, EXPECTATIONS_SHA, MAX_METADATA))
    resource.setrlimit(resource.RLIMIT_AS, (2147483648, 2147483648))
    allowed = os.sched_getaffinity(0); os.sched_setaffinity(0, {min(allowed)})
    client = Client('http://127.0.0.1:8081')
    before = client.json('/v2/sessions/current/status')
    require(before.get('run') is None, 'reference requires idle authoring')
    proofs = []
    for number in range(3):
        data, proof = load_case(number, client, expectations, gsg.SOURCE_IR_SHA256S)
        proofs.append(proof); del data
    dependency = triangle.dependency_provenance()
    if args.preflight:
        print(json.dumps({'status': 'PREFLIGHT PASS', 'cases': proofs, 'reference_evaluations': 0,
                          'dependency': dependency, 'new_solve': False}), flush=True)
        return 0
    claim_once(args.request_sha256)
    def stop(signum, frame):
        raise triangle.Refusal('reference wall-time exhausted or controlled termination')
    signal.signal(signal.SIGALRM, stop); signal.signal(signal.SIGTERM, stop); signal.alarm(43200)
    budget = gsg.GsgSourceConvergenceBudget()
    results, failed_case, failed_index = [], None, None
    report = {'schema': 'fullmag.gsg-source-convergence-reference-result.v1', 'request_sha256': args.request_sha256,
              'inputs': proofs, 'dependency': dependency, 'qualified_basis': False, 'new_solve': False,
              'qualification': 'NOT VERIFIED', 'point_results': results}
    try:
        for number, (label, cell_count, _bundle_sha) in enumerate(CASES):
            failed_case = label
            data, proof = load_case(number, client, expectations, gsg.SOURCE_IR_SHA256S)
            require(proof == proofs[number], 'source changed after preflight')
            budget.activate_source(gsg.SOURCE_IR_SHA256S[number])
            saved = list(struct.iter_unpack('<3d', data['h_raw']))
            for index, target in zip(INDICES, gsg.TARGETS_M):
                failed_index = index; started = time.monotonic()
                def progress(done, total):
                    elapsed = time.monotonic() - started
                    value = {'status': 'running', 'label': label, 'target_index': index, 'checks_completed': len(results),
                             'checks_total': 9, 'cells_completed': done, 'source_cells': total,
                             'target_elapsed_seconds': elapsed, 'estimated_target_remaining_seconds': elapsed*(total-done)/done,
                             'budget': budget.report(), 'new_solve': False}
                    write('progress.json', value)
                    print(json.dumps({k: v for k, v in value.items() if k != 'budget'}), flush=True)
                value = gsg.evaluate_retained_field(struct.iter_unpack('<5Q30d', data['cells']), target, cell_count, budget,
                                                    native_h_apm=saved[index], progress=progress)
                value.update(label=label, target_index=index, position_m=target, native_h_apm=saved[index],
                             elapsed_seconds=time.monotonic()-started)
                results.append(value); write(f'{label}-target-{index}.json', value)
                require(value['native_comparison']['within_gate'], 'native comparison outside preregistered gate')
            del data
        after = client.json('/v2/sessions/current/status')
        require(all(before.get(k) == after.get(k) for k in ('session', 'run')), 'authoring identity changed')
        for name, digest in request['tools'].items():
            checked(Path(__file__).parent / name, digest, MAX_METADATA)
        budget.guard(); report.update(status='NINE CHECKS PASS / NOT FULL QUALIFICATION', exit_code=0)
    except BaseException as error:
        report.update(status='REFUSED / NOT VERIFIED', exit_code=2, error=type(error).__name__ + ': ' + str(error),
                      failed_case=failed_case, failed_target_index=failed_index)
    report.update(budget=budget.report(), checks_completed=len(results), checks_passed=sum(v['native_comparison']['within_gate'] for v in results), checks_total=9)
    write('result.json', report); signal.alarm(0)
    print(json.dumps({k: report[k] for k in ('status', 'exit_code', 'checks_completed')}), flush=True)
    return report['exit_code']


if __name__ == '__main__':
    raise SystemExit(main())
