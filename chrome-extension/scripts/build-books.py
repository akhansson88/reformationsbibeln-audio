"""Build only book names and verse counts; do not bundle the Bible text."""
import json
from pathlib import Path

root = Path(__file__).resolve().parents[2]
source = json.loads((root / "reformationsbibeln.json").read_text())
books = [{"id": b["number"], "name": b["name"], "abbreviation": b["abbreviation"],
          "verses": [len(c["verses"]) for c in b["chapters"]]} for b in source["books"]]
payload = json.dumps(books, ensure_ascii=False, separators=(",", ":"))
target = root / "chrome-extension/lib/books.js"
target.write_text("// Generated from reformationsbibeln.json: names and verse counts only.\n"
                  "(function(r){const b=" + payload + ";if(typeof module==='object'&&module.exports)module.exports=b;else r.RBAudioBooks=b;})(globalThis);\n")
print(target)
