#!/usr/bin/env python3
"""Build trilium-fsrs.zip, a Trilium ZIP export (formatVersion 2) that can be imported directly.

Usage:  python3 build.py            -> fetches the latest ts-fsrs, writes trilium-fsrs.zip next to this file
        python3 build.py --offline  -> reuses the cached src/ts-fsrs.js instead of downloading
Then in Trilium: right-click a note -> Import into note -> pick the zip, UNTICK "Safe import".
"""
import json, sys, urllib.request, zipfile
from pathlib import Path

HERE = Path(__file__).parent
SRC = HERE / "src"

# External packages: name -> UMD bundle path inside the npm package. Always the latest version.
CDN = "https://cdn.jsdelivr.net/npm"
PACKAGES = {"ts-fsrs": "dist/index.umd.js"}

def fetch(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return r.read().decode()

def fetch_package(name, path):
    """Download the latest UMD build, cache it in src/, and return (code, version)."""
    cache = SRC / f"{name}.js"
    if "--offline" in sys.argv:
        return cache.read_text(), "cached"
    try:
        version = json.loads(fetch(f"{CDN}/{name}@latest/package.json"))["version"]
        code = fetch(f"{CDN}/{name}@{version}/{path}")   # pin the fetch to the version we just resolved
    except Exception as e:
        if not cache.exists():
            sys.exit(f"cannot download {name} and no cached copy: {e}")
        print(f"warning: download of {name} failed ({e}); using cached src/{name}.js")
        return cache.read_text(), "cached"
    cache.write_text(code)
    return code, version

libs = {name: fetch_package(name, path) for name, path in PACKAGES.items()}
for name, (_, version) in libs.items():
    print(f"{name}: {version}")

ID = dict(review="fsrsReview01", ui="fsrsReviewUi1", js="fsrsReviewJs1",
          state="fsrsState001", lib="fsrsTsFsrs01", opt="fsrsOptimizr1")

def label(name, value="", pos=10):
    return {"type": "label", "name": name, "value": value, "isInheritable": False, "position": pos}

def note(key, title, ntype, mime, data_file, parents, position, attrs=(), dir_name=None, children=()):
    m = {"noteId": ID[key], "notePath": [ID[k] for k in parents] + [ID[key]], "title": title,
         "notePosition": position, "prefix": None, "isExpanded": bool(children), "type": ntype,
         "mime": mime, "attributes": list(attrs), "dataFileName": data_file, "children": list(children)}
    if ntype == "text":
        m["format"] = "html"
    if children:
        m["dirFileName"] = dir_name or title
    return m

review_js = note("js", "review.js", "code", "application/javascript;env=frontend", "review.js", ["review", "ui"], 10)
review_ui = note("ui", "Review UI", "code", "text/html", "Review UI.html", ["review"], 10, children=[review_js])
state = note("state", "srs-state", "code", "application/json", "srs-state.json", ["review"], 20,
             attrs=[label("srsState"), label("disableVersioning", "true", 20)])
lib = note("lib", "ts-fsrs", "code", "text/javascript", "ts-fsrs.js", ["review"], 30,
           attrs=[label("fcLib", "ts-fsrs"), label("disableVersioning", "true", 20)])
optimizer = note("opt", "optimizer", "code", "text/javascript", "optimizer.js", ["review"], 40,
                 attrs=[label("fcLib", "optimizer"), label("disableVersioning", "true", 20)])
# The Review render note is the top-level folder: its children hold the UI, the state and the library.
review = note("review", "Flashcards", "render", "", "Flashcards.html", [], 10, dir_name="Flashcards",
              attrs=[{"type": "relation", "name": "renderNote", "value": ID["ui"], "isInheritable": False, "position": 10}],
              children=[review_ui, state, lib, optimizer])

meta = {"formatVersion": 2, "appVersion": "0.99.0", "files": [review]}

files = {
    "Flashcards.html": "",
    "Flashcards/Review UI.html": (SRC / "review-ui.html").read_text(),
    "Flashcards/Review UI/review.js": (SRC / "review.js").read_text(),
    "Flashcards/srs-state.json": (SRC / "srs-state.json").read_text(),
    "Flashcards/ts-fsrs.js": libs["ts-fsrs"][0],
    "Flashcards/optimizer.js": (SRC / "optimizer.js").read_text(),
}

out = HERE / "trilium-fsrs.zip"
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("!!!meta.json", json.dumps(meta, indent=2))
    for name, content in files.items():
        z.writestr(name, content)
print("wrote", out, f"({out.stat().st_size // 1024} KiB)")
