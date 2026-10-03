"""Setuptools compatibility entry point with managed Fullmag versioning."""

from pathlib import Path
import sys

from setuptools import setup

sys.path.insert(0, str(Path(__file__).resolve().parent))
from fullmag_build_backend import get_version


setup(version=get_version())
