#!/usr/bin/env python3
"""Tests for the reduced BORIS/Fullmag direct-SHE comparison oracle."""

from __future__ import annotations

import math

import pytest

from verify_boris_fullmag_she_1d import compare_direct_she_1d


def test_boris_fullmag_direct_she_mapping_matches_exact_profile() -> None:
    result = compare_direct_she_1d()

    assert result["status"] == "pass"
    assert result["mapping"] == "mu_s = 2 V_s"
    assert result["max_profile_relative_error"] < 1.0e-13
    assert result["max_normalized_flux_error"] < 1.0e-13


def test_mismatched_fullmag_spin_hall_angle_is_rejected() -> None:
    result = compare_direct_she_1d(theta_sh=0.08)

    assert result["status"] == "fail"
    assert result["max_profile_relative_error"] > 0.1


def test_invalid_geometry_is_rejected() -> None:
    with pytest.raises(ValueError, match="length_m"):
        compare_direct_she_1d(length_m=0.0)


def test_reference_values_are_finite() -> None:
    result = compare_direct_she_1d()

    assert all(math.isfinite(float(result[key])) for key in (
        "boris_spin_voltage_top_minus_bottom_v",
        "fullmag_spin_voltage_top_minus_bottom_v",
        "max_profile_relative_error",
        "max_normalized_flux_error",
    ))
