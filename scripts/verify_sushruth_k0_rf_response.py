"""Measure the preregistered uniform three-tone RF control from saved samples.

This independent postprocessor does not authenticate a run, execute a solver,
qualify antenna fields or replace Fullmag's production spin-wave analysis.
"""
import cmath
import math

from reference_sushruth_2020_response import _number
from reference_sushruth_2020_a8_diagnostic import uniform_susceptibility


def verify_rf_response(samples):
    """Check fixed 6/7.5/9 GHz amplitudes and phases over the 20--24 ns window."""
    if not samples:
        raise ValueError('RF control samples are missing')
    parsed=[]
    for sample in samples:
        time=_number('time_s',sample['time_s'])
        vector=tuple(_number('m',v) for v in sample['m'])
        if len(vector)!=3 or (parsed and time<=parsed[-1][0]):
            raise ValueError('RF control requires three finite components and increasing time')
        parsed.append((time,vector))
    if parsed[-1][0]<23.99e-9:
        raise ValueError('RF control did not reach the preregistered horizon')
    window=[s for s in parsed if 20e-9-1e-18<=s[0]<24e-9-1e-18]
    if len(window)!=2000:
        raise ValueError('RF observation window must contain all 2000 samples')
    for n,(time,_) in enumerate(window):
        if abs(time-(20e-9+n*2e-12))>1e-18:
            raise ValueError('RF observation cadence or clock units differ')
    ms=.89/(4e-7*math.pi)
    comparisons=[]
    for frequency in (6e9,7.5e9,9e9):
        expected=uniform_susceptibility(frequency,alpha=.01)
        weights=[cmath.exp(-1j*math.tau*frequency*t) for t,_ in window]
        for axis,component in enumerate(('xx','yx')):
            summands=[m[axis]*w for (_,m),w in zip(window,weights)]
            measured=2*ms/(len(window)*.1)*complex(
                math.fsum(z.real for z in summands),math.fsum(z.imag for z in summands))
            error=abs(measured-expected[axis]);limit=1e-4+1e-3*abs(expected[axis])
            comparisons.append({'frequency_hz':frequency,'component':component,
                                'measured':[measured.real,measured.imag],
                                'expected':[expected[axis].real,expected[axis].imag],
                                'absolute_error':error,'limit':limit,'passed':error<=limit})
    return {'passed':all(row['passed'] for row in comparisons),
            'window_sample_count':len(window),'comparisons':comparisons,
            'source_execution_verified':False,'antenna_or_publication_qualified':False}
