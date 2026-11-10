"""Create a fresh-repository archive with only portable release files."""
import hashlib
import json
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

ROOT = Path(__file__).resolve().parents[1]
audit = json.loads((ROOT / "data" / "audit.json").read_text(encoding="utf-8"))
seed = (ROOT / "data" / "seed.json").read_bytes()
if (audit["dataset"] != "ledger-synthetic-v1"
        or audit["sha256"] != hashlib.sha256(seed).hexdigest()
        or json.loads(seed)["version"] != audit["dataset"]):
    raise SystemExit("Run npm run prepare:data before packaging the release.")

files = [
    ".gitignore", "README.md", "ATTRIBUTION.md", "package.json", "package-lock.json", "wrangler.jsonc",
    "data/seed.json", "data/audit.json", "drizzle/0000_ledger.sql", "drizzle/meta/_journal.json",
    "reports/PowerQuery.m", "reports/THIRD_PARTY_NOTICES.txt",
    "scripts/build.mjs", "scripts/build-powerbi.mjs", "scripts/database.mjs", "scripts/local-server.mjs",
    "scripts/package_release.py", "scripts/prepare_data.py", "scripts/seed-d1.mjs",
    "tests/http.test.mjs", "tests/reporting.test.mjs", "tests/sample-upload.csv",
]
for folder in ("public", "worker"):
    files.extend(p.relative_to(ROOT).as_posix() for p in sorted((ROOT / folder).iterdir()) if p.is_file())
for artifact in ("Ledger.pbix", "Ledger.pbip.zip"):
    if (ROOT / "reports" / artifact).is_file():
        files.append("reports/" + artifact)

output = ROOT / "outputs" / "ledger-release.zip"
output.parent.mkdir(exist_ok=True)
with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
    for name in files:
        archive.write(ROOT / name, "ledger-banking-analytics/" + name)
print(f"Packaged {len(files)} release files at {output}")
