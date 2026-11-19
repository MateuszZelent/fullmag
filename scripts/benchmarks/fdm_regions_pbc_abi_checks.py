#!/usr/bin/env python3
"""Two-cell analytic exchange checks at periodic seams (native CUDA only).

Includes singleton axes, sparse u32 labels and local-A FACES. Native fp32
measurements do not open the planner's separate fp32/PBC capability gate.
"""
import ctypes as ct
import hashlib
import json
import os
from pathlib import Path

import fdm_cuda_analytic_abi_checks as abi
from fdm_regions_interaction_abi_checks import EDGE, MS, MU0, VOLUME, NativeFdm, normalized


def main():
    library = Path(abi.library_path()).resolve(strict=True)
    header = Path(os.environ.get('FULLMAG_FDM_HEADER') or Path(__file__).resolve().parents[2]/'native/include/fullmag_fdm.h')
    native = NativeFdm(library, header)
    initial = [normalized([1, 2, 3]), normalized([-2, 3, 1])]
    results = []
    for precision in ('double', 'single'):
        tolerance = 1e-12 if precision == 'double' else 1e-6
        for axis in range(3):
            grid = native.types['fullmag_fdm_grid_desc']()
            counts = [1,1,1]; counts[axis] = 2
            grid.nx,grid.ny,grid.nz = counts
            grid.dx = grid.dy = grid.dz = EDGE
            for periodic_axis in (0,1):
                for periodic_singletons in (0,1):
                    flags = [periodic_singletons]*3; flags[axis] = periodic_axis
                    for ids in ([0, 4294967295], [257, 1]):
                        labels = (ct.c_uint32*2)(*ids)
                        config = {'aex':13e-12, 'settings':{'enable_exchange':1,
                            'grid':grid, 'periodic_x':flags[0], 'periodic_y':flags[1], 'periodic_z':flags[2],
                            'region_mask':ct.cast(labels, ct.c_void_p), 'region_mask_len':2,
                            'exchange_pair_default':native.enum('EXCHANGE_PAIR_HARMONIC_MEAN')}}
                        with native.backend(initial, precision, **config) as (handle, _):
                            stats=native.stats_type()
                            status = native.lib.fullmag_fdm_backend_snapshot_stats(handle,ct.byref(stats))
                            if status:
                                raise RuntimeError(('native snapshot', status))
                            m=native.field(handle,'M'); h=native.field(handle,'H_EX')
                        links=1+periodic_axis
                        expected_energy=links*13e-12*VOLUME/EDGE**2*sum((a-b)**2 for a,b in zip(*m))
                        expected_field=[[2*links*13e-12/(MU0*MS[i]*EDGE**2)*(m[1-i][j]-m[i][j]) for j in range(3)] for i in range(2)]
                        field_error=max(abs(a-b) for x,y in zip(h,expected_field) for a,b in zip(x,y))/max(abs(a) for row in expected_field for a in row)
                        energy_error=abs(stats.total_energy_joules-expected_energy)/abs(expected_energy)
                        if not (field_error<=tolerance and energy_error<=tolerance):
                            raise AssertionError((precision,axis,flags,ids,field_error,energy_error))
                        results.append({'precision':precision,'counts':counts,'periodic':flags,'region_ids':ids,
                            'field_relative_error':field_error,'energy_relative_error':energy_error,'tolerance':tolerance,
                            'energy_j':stats.total_energy_joules,'expected_energy_j':expected_energy,'m':m,'h_apm':h,'expected_h_apm':expected_field})
        # Heterogeneous A uses two distinct +x seam connections when nx=2.
        effective_a=2*10e-12*20e-12/(10e-12+20e-12)
        for periodic_x in (0,1):
            with native.backend(initial, precision, aex=13e-12,
                    settings={'enable_exchange':1,'periodic_x':periodic_x,'periodic_y':1,'periodic_z':1},
                    arrays={'a_field':[10e-12,20e-12]},
                    exchange_faces=[effective_a,effective_a if periodic_x else 0.]) as (handle,_):
                stats=native.stats_type()
                status = native.lib.fullmag_fdm_backend_snapshot_stats(handle,ct.byref(stats))
                if status:
                    raise RuntimeError(('native snapshot', status))
                m=native.field(handle,'M');h=native.field(handle,'H_EX')
            links=1+periodic_x
            expected_energy=links*effective_a*VOLUME/EDGE**2*sum((a-b)**2 for a,b in zip(*m))
            expected_field=[[2*links*effective_a/(MU0*MS[i]*EDGE**2)*(m[1-i][j]-m[i][j]) for j in range(3)] for i in range(2)]
            field_error=max(abs(a-b) for x,y in zip(h,expected_field) for a,b in zip(x,y))/max(abs(a) for row in expected_field for a in row)
            energy_error=abs(stats.total_energy_joules-expected_energy)/abs(expected_energy)
            if not (field_error<=tolerance and energy_error<=tolerance):
                raise AssertionError(('local_A',precision,periodic_x,field_error,energy_error))
            results.append({'case':'local_A_faces','precision':precision,'periodic_x':periodic_x,
                'field_relative_error':field_error,'energy_relative_error':energy_error,'tolerance':tolerance,
                'expected_energy_j':expected_energy,'energy_j':stats.total_energy_joules,'m':m,'h_apm':h,'expected_h_apm':expected_field})
    print(json.dumps({'schema':'fullmag.fdm-regional-pbc-abi.v1','state':'passed',
        'scope':'two-cell periodic exchange and singleton axes; raw native fp32 does not qualify public fp32/PBC',
        'library_sha256':hashlib.sha256(library.read_bytes()).hexdigest(),
        'header_sha256':hashlib.sha256(header.read_bytes()).hexdigest(),
        'script_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'ms_apm':MS,'initial_m':initial,'edge_m':EDGE,'checks':results},sort_keys=True))


if __name__=='__main__':main()
