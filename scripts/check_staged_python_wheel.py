"""Verify a staged project wheel against frozen content and project identity."""

import argparse
from email.parser import BytesParser
import hashlib
from io import BytesIO
from pathlib import Path
import re
import tomllib
import zipfile


def normalized(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def verify(wheel, project, expected_hash):
    payload = wheel.read_bytes()
    if hashlib.sha256(payload).hexdigest() != expected_hash:
        raise ValueError("Staged Fullmag wheel hash differs from frozen input")
    identity = tomllib.loads(project.read_text(encoding="utf-8"))["project"]
    parts = wheel.name.removesuffix(".whl").split("-")
    if wheel.suffix != ".whl" or len(parts) not in (5, 6):
        raise ValueError("Invalid project wheel filename")
    if normalized(parts[0]) != normalized(identity["name"]) or parts[1] != identity["version"]:
        raise ValueError("Project wheel filename differs from project name/version")
    with zipfile.ZipFile(BytesIO(payload)) as archive:
        metadata_paths = [name for name in archive.namelist() if name.endswith(".dist-info/METADATA")]
        expected_directory = f"{parts[0]}-{parts[1]}.dist-info/METADATA"
        if metadata_paths != [expected_directory]:
            raise ValueError("Project wheel must have one matching metadata directory")
        metadata = BytesParser().parsebytes(archive.read(metadata_paths[0]))
        if metadata.get_all("Name") != [identity["name"]] or metadata.get_all("Version") != [identity["version"]]:
            raise ValueError("Project wheel embedded name/version differs from project")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wheel", type=Path, required=True)
    parser.add_argument("--project", type=Path, required=True)
    parser.add_argument("--sha256", required=True)
    args = parser.parse_args()
    try:
        verify(args.wheel, args.project, args.sha256)
    except (ValueError, OSError, zipfile.BadZipFile, KeyError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
