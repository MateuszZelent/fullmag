"""Uniform-metal thickness effect in the published thin-strip approximation.

This compares source models; it does not correct a native field, evaluate RT0,
or compute the spin-wave transmission. The y direction is infinite and the
current density is uniform through metal thickness.
"""
import math

WAVENUMBERS_RAD_PER_M = (0., 1e6, 3e6, 5e6, 7e6, 10e6, 20e6)


def _number(value, name):
    if type(value) not in (float,int) or not math.isfinite(value):
        raise ValueError(name+" must be finite numeric data, not bool")
    return float(value)


def metal_thickness_factor(k_rad_per_m, metal_thickness_m):
    """Return the average exp(-|k|z) on 0 <= z <= metal thickness."""
    k = _number(k_rad_per_m,"k_rad_per_m")
    thickness = _number(metal_thickness_m,"metal_thickness_m")
    if thickness < 0.:
        raise ValueError("metal_thickness_m must be nonnegative")
    argument = abs(k)*thickness
    if not math.isfinite(argument):
        raise ValueError("dimensionless metal thickness argument overflows")
    return -math.expm1(-argument)/argument if argument else 1.


def geometry_filter_report(parameters_si):
    """Use the retained geometric parameters without fitting source data."""
    if type(parameters_si) is not dict:
        raise ValueError("geometric parameters must be a dict")
    names = ("conductor_width_m","gap_m","metal_thickness_m","insulator_thickness_m")
    values = {key:_number(parameters_si[key],key) for key in names}
    if values["conductor_width_m"] <= 0. or any(values[key] < 0. for key in names[1:]):
        raise ValueError("invalid retained geometric dimensions")
    rows = []
    for k in WAVENUMBERS_RAD_PER_M:
        factor = metal_thickness_factor(k,values["metal_thickness_m"])
        try:
            center_factor = math.exp(abs(k)*values["metal_thickness_m"]/2)*factor
        except OverflowError as error:
            raise ValueError("midplane comparison factor overflows") from error
        rows.append(dict(k_rad_per_m=k,amplitude_factor=factor,
                         unnormalized_weight_factor=factor*factor,factor_phase_rad=0.,
                         center_sheet_amplitude_factor=center_factor,
                         center_sheet_weight_factor=center_factor*center_factor,
                         zero_k_is_factor_limit_not_gsg_field_ratio=(k==0.)))
    return dict(parameters_si=values,rows=rows,
                sheet_comparison_planes_m=dict(lower_surface=values["insulator_thickness_m"],
                    metal_midplane=values["insulator_thickness_m"]+values["metal_thickness_m"]/2),
                comparison="uniform finite-thickness vs thin sheets at the lower surface and metal midplane; same signed branch currents",
                source_assumptions="infinite y; equal uniform thickness; no RF screening or end connections",
                fullmag_solver_executed=False,native_field_comparison_performed=False,
                response_R_T_computed=False,qualified_basis=False,publication_reproduced=False,
                explains_previous_thin_model_figure3_discrepancy=False)
