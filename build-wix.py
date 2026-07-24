#!/usr/bin/env python3
"""
Build a single, self-contained HTML file for Wix.

Wix's "Embed HTML" / "Custom Element" runs your code in a sandboxed iframe with
no file system, so relative paths like css/site.css or js/site.js never resolve.
This script inlines every stylesheet and script into one file that can be pasted
straight into Wix.

Run:  python3 build-wix.py
Out:  wix/elias-lab-wix.html

The multi-file site stays the single source of truth — re-run this after any edit.
"""
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent
OUT_DIR = ROOT / "wix"
OUT_FILE = OUT_DIR / "elias-lab-wix.html"

# Where the Lab Notebook is hosted. Wix can't run the notebook itself (it needs
# its own page + Supabase), so point this at wherever you deploy notebook.html.
NOTEBOOK_URL = "https://amerelias12.github.io/elias-lab/notebook.html"


def read(rel: str) -> str:
    # strip any ?v= cache-busting suffix before touching the filesystem
    rel = rel.split("?")[0]
    path = ROOT / rel
    if not path.exists():
        sys.exit(f"error: missing {rel}")
    return path.read_text(encoding="utf-8")


def main() -> None:
    html = read("index.html")

    # 1. inline stylesheets, in document order
    def inline_css(match: re.Match) -> str:
        href = match.group(1)
        if href.startswith("http"):
            return match.group(0)  # leave Google Fonts alone
        return f"<style>\n/* ---- {href} ---- */\n{read(href)}\n</style>"

    html = re.sub(
        r'<link rel="stylesheet" href="([^"]+)"\s*/?>', inline_css, html
    )

    # 2. inline local scripts
    def inline_js(match: re.Match) -> str:
        src = match.group(1)
        if src.startswith("http"):
            return match.group(0)
        return f"<script>\n/* ---- {src} ---- */\n{read(src)}\n</script>"

    html = re.sub(r'<script src="([^"]+)"></script>', inline_js, html)

    # 3. the notebook lives outside Wix
    html = html.replace('href="notebook.html"', f'href="{NOTEBOOK_URL}" target="_blank" rel="noopener"')

    # 4. leave a note for whoever opens the generated file
    banner = (
        "<!--\n"
        "  GENERATED FILE — do not edit by hand.\n"
        "  Built from index.html + css/ + js/ by build-wix.py.\n"
        "  Paste the whole file into Wix: Add > Embed Code > Embed HTML > Code.\n"
        "  Images still use relative assets/ paths: upload them to Wix Media and\n"
        "  replace the src=\"assets/...\" URLs, or leave them — each one falls back\n"
        "  to a styled text badge so nothing renders broken.\n"
        "-->\n"
    )
    html = banner + html

    OUT_DIR.mkdir(exist_ok=True)
    OUT_FILE.write_text(html, encoding="utf-8")

    kb = len(html.encode("utf-8")) / 1024
    remaining = re.findall(r'(?:href|src)="(?!http|data:|#|mailto:)([^"]+)"', html)
    print(f"wrote {OUT_FILE.relative_to(ROOT)}  ({kb:.0f} KB)")
    if remaining:
        print("relative paths left (images — expected):")
        for r in sorted(set(remaining)):
            print(f"  {r}")

    build_scanner_embed()


SCANNER_EMBED = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>attB-like Site Scanner — Elias Lab</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600&family=IBM+Plex+Sans:wght@400;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:'IBM Plex Sans',system-ui,sans-serif;background:linear-gradient(140deg,#0c4a44,#072e2a);color:#f4f1e8;padding:1.5rem;display:flex;justify-content:center;}
.wrap{width:100%;max-width:620px;}
.head{font-family:'Fraunces',Georgia,serif;font-size:1.3rem;font-weight:600;margin-bottom:.5rem;}
.sub{font-size:.9rem;color:rgba(244,241,232,.8);line-height:1.6;margin-bottom:1.1rem;}
.sub strong{color:#1fd197;}
.row{display:flex;gap:.6rem;flex-wrap:wrap;}
input{flex:1;min-width:200px;padding:.8rem 1rem;border-radius:100px;border:1.5px solid rgba(244,241,232,.25);background:rgba(7,46,42,.35);color:#f4f1e8;font-family:'IBM Plex Mono',monospace;font-size:13px;outline:none;transition:all .2s;}
input::placeholder{color:rgba(244,241,232,.5);}
input:focus{border-color:#1fd197;box-shadow:0 0 0 3px rgba(31,209,151,.25);}
button{padding:.8rem 1.8rem;border-radius:100px;border:none;background:#1fd197;color:#072e2a;font-weight:600;font-size:14px;cursor:pointer;font-family:inherit;transition:all .25s;}
button:hover{background:#fff;transform:translateY(-2px);}
.scan-result{margin-top:1.2rem;padding:1.2rem 1.4rem;border-radius:14px;background:rgba(7,46,42,.45);border:1px solid rgba(31,209,151,.22);}
.scan-num{font-family:'Fraunces',Georgia,serif;font-size:2.6rem;font-weight:600;color:#1fd197;line-height:1;}
.scan-cap{font-size:.9rem;color:rgba(244,241,232,.85);margin-top:.3rem;}
.scan-note{font-size:.86rem;color:rgba(244,241,232,.8);line-height:1.6;margin-top:.7rem;}
.scan-note strong{color:#f4f1e8;}
a{color:#1fd197;font-weight:600;}
.disclaimer{font-size:11px;color:rgba(244,241,232,.45);margin-top:1rem;}
</style>
</head>
<body>
<div class="wrap">
  <div class="head">&#128269; Try our att-site scanner</div>
  <p class="sub">Enter a <strong>gene name</strong> to see how many HK022 <strong>attB-like integration sites</strong> it contains.</p>
  <div class="row">
    <input id="scan-input" type="text" placeholder="Enter a gene name &mdash; e.g. BRCA1" aria-label="Gene name">
    <button id="scan-btn" type="button">Scan</button>
  </div>
  <div id="scan-result" class="scan-result" hidden></div>
  <p class="disclaimer">Preview tool &mdash; a simplified taste of our internal GenomeScan pipeline. Exact site maps are shared with collaborators.</p>
</div>
<script>
__SCANNER_JS__
</script>
</body>
</html>
"""


def build_scanner_embed() -> None:
    """A small standalone widget — for embedding beside natively-built Wix sections."""
    js = read("js/scan-widget.js")
    out = OUT_DIR / "scanner-embed.html"
    out.write_text(SCANNER_EMBED.replace("__SCANNER_JS__", js), encoding="utf-8")
    kb = out.stat().st_size / 1024
    print(f"wrote {out.relative_to(ROOT)}  ({kb:.0f} KB)")


if __name__ == "__main__":
    main()
