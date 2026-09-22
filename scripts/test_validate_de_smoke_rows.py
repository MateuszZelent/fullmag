from pathlib import Path
import csv
import pytest
from validate_de_smoke_rows import validate_rows, SAMPLING


def write(path, rows):
    with path.open('w',newline='') as stream:
        w=csv.DictWriter(stream,fieldnames=list(rows[0]));w.writeheader();w.writerows(rows)


def rows(sampling):
    return [dict(sample_index=i,raw_mode_index=0,branch_id=3,
                 kx_rad_per_m=0,ky_rad_per_m=k,kz_rad_per_m=0,
                 frequency_hz=9.3e9+i*2e8,residual_norm=1e-10)
            for i,k in enumerate(SAMPLING[sampling])]


@pytest.mark.parametrize('sampling',['two','five'])
def test_complete_rows_are_only_preflight_not_qualification(tmp_path,sampling):
    path=tmp_path/'dispersion.csv';write(path,rows(sampling))
    result=validate_rows(path,sampling)
    assert result['status']=='pass'
    assert result['qualification']=='NOT VERIFIED'
    assert result['pending_requirements']


@pytest.mark.parametrize('key,value',[
    ('sample_index',-1),('sample_index',0.5),('sample_index',1),
    ('raw_mode_index',-1),('branch_id',''),('frequency_hz',''),
    ('frequency_hz',float('nan')),('frequency_hz',2.8e9),
    ('residual_norm',-1),('residual_norm',float('inf')),('residual_norm',''),
    ('ky_rad_per_m',1e6),('kx_rad_per_m',1),
])
def test_invalid_or_misbound_row_is_rejected(tmp_path,key,value):
    data=rows('two');data[0][key]=value
    path=tmp_path/'dispersion.csv';write(path,data)
    with pytest.raises(ValueError):validate_rows(path,'two')


@pytest.mark.parametrize('mutation',['missing','duplicate','branch_alias'])
def test_incomplete_or_duplicate_samples_fail(tmp_path,mutation):
    data=rows('two')
    if mutation=='missing':data.pop()
    else:
        extra=dict(data[0])
        if mutation=='branch_alias':extra['raw_mode_index']=1
        data.append(extra)
    path=tmp_path/'dispersion.csv';write(path,data)
    with pytest.raises(ValueError):validate_rows(path,'two')


def test_absolute_residual_is_not_compared_to_relative_tolerance(tmp_path):
    data=rows('two')
    for row in data: row['residual_norm']=1e3
    path=tmp_path/'dispersion.csv';write(path,data)
    result=validate_rows(path,'two')
    assert result['max_absolute_residual_norm']==1e3
    assert result['qualification']=='NOT VERIFIED'
    assert any('original-pencil residual' in item for item in result['pending_requirements'])
