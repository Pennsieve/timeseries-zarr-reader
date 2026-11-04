"""Replace test-data/conformance/ with the conformance fixtures of the spec.

Downloads the source distribution of the installed `timeseries-zarr` release,
runs its scripts/build_fixtures.py into a temporary directory, and swaps the
result in. The script exits with an error and leaves test-data/conformance/
untouched when the generated manifest.json differs from the release's
committed conformance/manifest.json.

Usage: python scripts/sync-conformance-fixtures.py
       (in an environment that has installed scripts/requirements.txt)
"""

import shutil
import subprocess
import sys
import tarfile
import tempfile
from importlib.metadata import version
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
TARGET = REPO / "test-data" / "conformance"
PACKAGE = "timeseries-zarr"


def fetch_source(scratch: Path) -> Path:
    """Download and unpack the source distribution of the installed release.

    Args:
        scratch: A directory to download and unpack into.

    Returns:
        The root directory of the unpacked source distribution.
    """
    downloads = scratch / "download"
    subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "download",
            f"{PACKAGE}=={version(PACKAGE)}",
            "--no-deps",
            "--no-binary",
            PACKAGE,
            "--quiet",
            "--dest",
            str(downloads),
        ],
        check=True,
    )
    (archive,) = downloads.glob("*.tar.gz")
    unpacked = scratch / "source"
    with tarfile.open(archive) as tar:
        tar.extractall(unpacked, filter="data")
    (root,) = unpacked.iterdir()
    return root


def main() -> int:
    """Rebuild the fixtures and replace test-data/conformance/.

    Returns:
        The exit status.
    """
    with tempfile.TemporaryDirectory() as scratch_name:
        scratch = Path(scratch_name)
        source = fetch_source(scratch)
        committed = source / "conformance" / "manifest.json"
        built = scratch / "conformance"
        subprocess.run(
            [
                sys.executable,
                "-I",
                str(source / "scripts" / "build_fixtures.py"),
                str(built),
            ],
            check=True,
            cwd=scratch,
        )
        if (built / "manifest.json").read_bytes() != committed.read_bytes():
            print(
                f"the generated manifest.json differs from the one in "
                f"{PACKAGE} {version(PACKAGE)}",
                file=sys.stderr,
            )
            return 1
        if TARGET.exists():
            shutil.rmtree(TARGET)
        TARGET.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(built, TARGET)
    print(f"wrote {TARGET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
