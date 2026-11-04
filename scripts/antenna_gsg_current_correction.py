"""Existing weighted RT0/H1 correction from retained V, sigma and local J.

Mathematical analysis only. The caller authenticates the complete raw source,
its prepared identity and budget; this neither solves nor qualifies a source.
"""
from collections.abc import Mapping
from decimal import Context, Decimal, ROUND_HALF_EVEN, localcontext
from itertools import zip_longest
import math

from antenna_rt0_surface_oracle import fit_retained_rt0


def weighted_rt0_h1_correction(cells, electric_potential_v, conductivity_spm, expected_cells):
    """Exact degree-two Tet4 integrals in Decimal120; no centroid quadrature."""
    def require(condition, reason):
        if not condition:
            raise ValueError(reason)

    def number(value):
        require(type(value) in (float, int), 'finite numeric data required')
        try:
            value=float(value)
        except OverflowError as error:
            raise ValueError('numeric input outside binary64 range') from error
        require(math.isfinite(value), 'finite numeric data required')
        return Decimal.from_float(value)

    require(type(expected_cells) is int and 0 < expected_cells <= 72911, 'invalid complete source cell count')
    require(isinstance(electric_potential_v, Mapping) and 0 < len(electric_potential_v) <= 4*expected_cells,
            'invalid potential identity map')
    require(all(type(i) is int and 0 <= i < 2**64 for i in electric_potential_v), 'invalid potential vertex identity')
    potentials={i:number(v) for i,v in electric_potential_v.items()}
    dot=lambda a,b:sum((x*y for x,y in zip(a,b)),Decimal(0))
    cross=lambda a,b:(a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0])
    seen=set(); completed=0
    with localcontext(Context(prec=120, rounding=ROUND_HALF_EVEN)):
        numerator=denominator=Decimal(0)
        for row,sigma_value in zip_longest(cells,conductivity_spm):
            require(completed < expected_cells and row is not None and sigma_value is not None,
                    'source cell or conductivity count differs')
            require(isinstance(row,(tuple,list)) and len(row)==35 and type(row[0]) is int and row[0]==completed,
                    'source cell ordinal or shape differs')
            ids=row[1:5]
            require(all(type(i) is int and 0 <= i < 2**64 for i in ids) and len(set(ids))==4,
                    'invalid source cell vertex identity')
            require(all(i in potentials for i in ids), 'source potential identity missing')
            seen.update(ids)
            values=[number(v) for v in row[5:]]
            vertices=[tuple(values[3*i:3*i+3]) for i in range(4)]
            current=[tuple(values[12+3*i:15+3*i]) for i in range(4)]
            fit_retained_rt0([row[5+3*i:8+3*i] for i in range(4)],
                             [row[17+3*i:20+3*i] for i in range(4)])
            sigma=number(sigma_value);require(sigma>0,'positive conductivity required')
            edges=[tuple(v[k]-vertices[0][k] for k in range(3)) for v in vertices[1:]]
            cofactors=[cross(edges[1],edges[2]),cross(edges[2],edges[0]),cross(edges[0],edges[1])]
            determinant=dot(edges[0],cofactors[0]);require(determinant>0,'positive Tet4 required')
            volume=determinant/6
            gradient=tuple(sum(((potentials[ids[i+1]]-potentials[ids[0]])*cofactors[i][k]
                                for i in range(3)),Decimal(0))/determinant for k in range(3))
            h1=tuple(-sigma*g for g in gradient)
            difference=[tuple(j[k]-h1[k] for k in range(3)) for j in current]
            summed=tuple(sum((q[k] for q in difference),Decimal(0)) for k in range(3))
            numerator+=volume/(20*sigma)*(sum((dot(q,q) for q in difference),Decimal(0))+dot(summed,summed))
            denominator+=volume/sigma*dot(h1,h1)
            completed+=1
        require(completed==expected_cells,'source cell count is incomplete')
        require(seen==set(potentials),'unused source potential identity')
        require(denominator>0,'zero H1 norm cannot define eta')
        eta=(numerator/denominator).sqrt();rounded=float(eta)
        require(math.isfinite(rounded) and (rounded!=0 or eta==0),'eta outside binary64 range')
        return {'eta':rounded,'eta_decimal':str(eta),'correction_energy_W':str(numerator),
                'h1_energy_W':str(denominator),'cells_completed':completed,'arithmetic':'Decimal120',
                'qualification':'NOT VERIFIED','qualified_basis':False,
                'source_authentication':'caller responsibility; mathematical analysis only'}


def partitioned_weighted_rt0_h1_correction(cells, electric_potential_v, conductivity_spm, expected_cells, parts):
    """Localize the same correction on an exact cell partition; never average eta."""
    from itertools import islice

    def require(condition, reason):
        if not condition:
            raise ValueError(reason)

    require(type(expected_cells) is int and 0 < expected_cells <= 72911, 'invalid complete source cell count')
    require(isinstance(electric_potential_v, Mapping)
            and 0 < len(electric_potential_v) <= 4*expected_cells
            and all(type(i) is int and 0 <= i < 2**64 for i in electric_potential_v),
            'invalid potential identity map')
    require(isinstance(parts, Mapping) and 0 < len(parts) <= expected_cells, 'invalid source partition')
    rows=list(islice(cells,expected_cells+1));sigmas=list(islice(conductivity_spm,expected_cells+1))
    require(len(rows)==len(sigmas)==expected_cells,'source cell or conductivity count differs')
    require(all(isinstance(row,(tuple,list)) and len(row)==35
                and type(row[0]) is int and row[0]==i for i,row in enumerate(rows)),
            'source cell ordinal or shape differs')
    partition=[];seen=set()
    for part_id,ordinals in parts.items():
        require(type(part_id) is str and bool(part_id.strip()), 'invalid source part identity')
        indices=list(islice(ordinals,expected_cells+1))
        require(0 < len(indices) <= expected_cells
                and all(type(i) is int and 0 <= i < expected_cells for i in indices),
                'invalid source part ordinal')
        require(len(set(indices))==len(indices) and not seen.intersection(indices),
                'source partition repeats or overlaps cells')
        seen.update(indices);partition.append((part_id,indices))
    require(len(seen)==expected_cells,'source partition is incomplete')
    used={i for row in rows for i in row[1:5]}
    require(used==set(electric_potential_v),'source potential identity missing or unused')
    results=[]
    with localcontext(Context(prec=120, rounding=ROUND_HALF_EVEN)):
        numerator=denominator=Decimal(0)
        for part_id,indices in partition:
            selected=[rows[i] for i in indices];used={i for row in selected for i in row[1:5]}
            result=weighted_rt0_h1_correction(
                ((i,*row[1:]) for i,row in enumerate(selected)),
                {i:electric_potential_v[i] for i in used},(sigmas[i] for i in indices),len(indices))
            numerator+=Decimal(result['correction_energy_W']);denominator+=Decimal(result['h1_energy_W'])
            results.append({'part_id':part_id,'source_cells':len(indices),**result})
        eta=(numerator/denominator).sqrt();rounded=float(eta)
        require(math.isfinite(rounded) and (rounded!=0 or eta==0),'eta outside binary64 range')
        for result in results:
            result['correction_energy_fraction']=(float(Decimal(result['correction_energy_W'])/numerator)
                                                  if numerator else None)
            result['h1_energy_fraction']=float(Decimal(result['h1_energy_W'])/denominator)
        return {'eta':rounded,'eta_decimal':str(eta),'correction_energy_W':str(numerator),
                'h1_energy_W':str(denominator),'cells_completed':expected_cells,'parts':results,
                'arithmetic':'Decimal120','qualification':'NOT VERIFIED','qualified_basis':False,
                'continuum_error_bound':False,'field_error_bound':False,
                'source_authentication':'caller responsibility; mathematical analysis only'}
