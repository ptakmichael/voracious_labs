"""Smart EM Solver demo backend."""
import os
from pathlib import Path


def _load_dotenv() -> None:
    """Read backend/.env (git-ignored) so each developer keeps their own API keys out of the repo.
    Variables already set in the shell win."""
    path = Path(__file__).resolve().parents[2] / ".env"
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key, value = key.strip().removeprefix("export ").strip(), value.strip().strip("'\"")
        if key and value and key not in os.environ:
            os.environ[key] = value


_load_dotenv()
