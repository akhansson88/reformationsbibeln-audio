"""Produce a deterministic, dependency-free unpacked Chrome installation ZIP."""
import argparse
import json
import zipfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("--output", type=Path, required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / "manifest.json").read_text())
folder = "Reformationsbibeln-Chrome-" + manifest["version"]
args.output.mkdir(parents=True, exist_ok=True)
target = args.output / (folder + ".zip")
files = [root / name for name in ["manifest.json", "background.js", "content.js", "player.html", "player.css", "player.js", "report-ui.js", "popup.html", "popup.css", "README.md"]]
files += sorted((root / "lib").glob("*.js")) + sorted((root / "icons").glob("*.png"))
files += sorted((root / "vendor").glob("*")) + sorted((root / "firebase").glob("*.rules")) + sorted((root / "firebase").glob("*.json")) + [root / "firebase/README.md"]
if not (root / "vendor/firebase-client.js").is_file():
    raise SystemExit("Build the locally bundled Firebase SDK first: cd chrome-extension && npm ci && npm run build")
with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as output:
    for path in files:
        item = zipfile.ZipInfo(folder + "/" + path.relative_to(root).as_posix(), date_time=(2026, 10, 13, 0, 0, 0))
        item.compress_type = zipfile.ZIP_DEFLATED
        item.external_attr = 0o100644 << 16
        output.writestr(item, path.read_bytes())
print(target)
