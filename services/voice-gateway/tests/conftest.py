import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

os.environ.setdefault("PROVIDER_CONFIG_ENCRYPTION_KEY", "test-only-key-not-a-secret")
