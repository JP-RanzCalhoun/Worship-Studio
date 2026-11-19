"""Launcher used by the desktop app: makes the `wsa` package importable without installing it."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from wsa.cli import main  # noqa: E402

if __name__ == "__main__":
    main()
