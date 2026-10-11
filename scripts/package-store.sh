#!/usr/bin/env bash
# Builds the Chrome Web Store upload: the *contents* of dist/ext/ zipped with manifest.json at the
# zip root, bundled System 1 models included (nothing is downloaded at runtime).
#
# Usage: npm run package:store   ->  releases/ScrollCollector-<version>-store.zip
# Needs the models once: npm run fetch:models
set -euo pipefail
cd "$(dirname "$0")/.."

node scripts/build-ext.mjs

# build-ext.mjs skips missing runtime entries silently: check the package holds every file the
# manifest and models/manifest.json name, and that the versions agree.
node -e '
const fs = require("fs");
const path = require("path");
const ext = "dist/ext";
const m = JSON.parse(fs.readFileSync(path.join(ext, "manifest.json"), "utf8"));
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
const fail = (msg) => { console.error("[package-store] " + msg); process.exit(1); };
if (m.version !== pkg.version) fail(`manifest.json ${m.version} != package.json ${pkg.version}`);
const named = [
  m.background && m.background.service_worker,
  m.side_panel && m.side_panel.default_path,
  ...Object.values(m.icons || {}),
  ...Object.values((m.action && m.action.default_icon) || {}),
  ...(m.content_scripts || []).flatMap((c) => [...(c.js || []), ...(c.css || [])])
].filter(Boolean);
const modelsManifest = path.join(ext, "models/manifest.json");
if (!fs.existsSync(modelsManifest)) fail("no bundled models in dist/ext (run npm run fetch:models)");
const models = Object.keys(JSON.parse(fs.readFileSync(modelsManifest, "utf8")).files || {});
if (!models.length) fail("models/manifest.json lists no model files");
named.push(...models.map((f) => "models/" + f));
// Licence notices must ship (Apache-2.0 and MIT parts are bundled): LICENSE, THIRD_PARTY_NOTICES.md and
// the licence text of each bundled part.
named.push(
  "licenses/LICENSE",
  "licenses/THIRD_PARTY_NOTICES.md",
  "licenses/third-party/Apache-2.0.txt",
  "licenses/third-party/huggingface-jinja-MIT.txt",
  "licenses/third-party/onnxruntime-MIT.txt",
  "licenses/third-party/bge-small-en-v1.5-MIT.txt"
);
const missing = named.filter((f) => !fs.existsSync(path.join(ext, f)));
if (missing.length) fail("missing from dist/ext: " + missing.join(", "));
console.log(`[package-store] ${m.version}: ${named.length} named files present (${models.length} model files)`);
'

version=$(node -p 'require("./dist/ext/manifest.json").version')
mkdir -p releases
out="releases/ScrollCollector-${version}-store.zip"
rm -f "$out"
(cd dist/ext && zip -qr -X "../../$out" . -x '*.DS_Store')
unzip -l "$out" | grep -q ' manifest.json$' || { echo "[package-store] manifest.json is not at the zip root"; exit 1; }
echo "[package-store] $out ($(du -h "$out" | cut -f1))"
