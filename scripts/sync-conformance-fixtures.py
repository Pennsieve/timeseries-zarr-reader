"""Replace test-data/conformance/ with the conformance fixtures of the spec.

Runs scripts/build_fixtures.py from a timeseries-zarr-py checkout into a
temporary directory and swaps the result in. The script exits with an error and
leaves test-data/conformance/ untouched when the generated manifest.json
differs from the checkout's committed conformance/manifest.json.

Usage: <timeseries-zarr-py venv python> scripts/sync-conformance-fixtures.py
       (set TIMESERIES_ZARR_PY to the checkout; defaults to
       ../timeseries-zarr-py)
"""

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
PY_REPO = Path(
    os.environ.get("TIMESERIES_ZARR_PY", REPO.parent / "timeseries-zarr-py")
)
TARGET = REPO / "test-data" / "conformance"


def main() -> int:
    """Rebuild the fixtures and replace test-data/conformance/.

    Returns:
        The exit status.
    """
    committed = PY_REPO / "conformance" / "manifest.json"
    script = PY_REPO / "scripts" / "build_fixtures.py"
    if not committed.is_file() or not script.is_file():
        print(
            f"{PY_REPO} is not a timeseries-zarr-py checkout",
            file=sys.stderr,
        )
        return 1
    with tempfile.TemporaryDirectory() as scratch:
        built = Path(scratch) / "conformance"
        subprocess.run(
            [sys.executable, str(script), str(built)],
            check=True,
            cwd=PY_REPO,
        )
        if (built / "manifest.json").read_bytes() != committed.read_bytes():
            print(
                f"the generated manifest.json differs from {committed}",
                file=sys.stderr,
            )
            return 1
        if TARGET.exists():
            shutil.rmtree(TARGET)
        TARGET.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(built, TARGET)
        shutil.copyfile(committed, TARGET / "manifest.json")
    print(f"wrote {TARGET}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
