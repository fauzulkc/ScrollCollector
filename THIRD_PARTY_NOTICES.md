# Third-party notices

ScrollCollector's own code is offered under the PolyForm Noncommercial License 1.0.0 (see [LICENSE](LICENSE)).
The parts below are bundled with the extension or the installer and keep their own licences. Licence texts
are in [third_party/licenses/](third_party/licenses/) and ship inside the extension under `licenses/`.
Each licence below was read from the part's own package file, licence file or model card, not assumed.

## Bundled in the extension (`dist/ext`)

| Part | Version | Licence | Source | Licence text |
|---|---|---|---|---|
| @huggingface/transformers (Transformers.js), vendored as `lib/vendor/transformers.min.js` | 3.4.0 | Apache-2.0 | https://github.com/huggingface/transformers.js | `Apache-2.0.txt` |
| onnxruntime-web (ONNX Runtime Web, inlined in that bundle, plus the vendored `ort-wasm-simd-threaded.jsep.mjs` and `.wasm`) | 1.22.0-dev.20250306-ccf8fdd9ea | MIT | https://github.com/microsoft/onnxruntime | `onnxruntime-MIT.txt` |
| onnxruntime-common (inlined in that bundle) | 1.20.1 | MIT | https://github.com/microsoft/onnxruntime | `onnxruntime-MIT.txt` |
| @huggingface/jinja (inlined in that bundle) | 0.3.4 | MIT (Copyright (c) 2023 Hugging Face) | https://github.com/huggingface/huggingface.js | `huggingface-jinja-MIT.txt` |
| Xenova/all-MiniLM-L6-v2 (q8 ONNX weights, config and tokenizer, `models/`) | Hugging Face revision 751bff37182d3f1213fa05d7196b954e230abad9 | Apache-2.0 (model card metadata) | https://huggingface.co/Xenova/all-MiniLM-L6-v2 (ONNX conversion of https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) | `Apache-2.0.txt` |
| Xenova/bge-small-en-v1.5 (q8 ONNX weights, config and tokenizer, `models/`) | Hugging Face revision ea104dacec62c0de699686887e3f920caeb4f3e3 | MIT (the upstream model BAAI/bge-small-en-v1.5 declares MIT; the Xenova conversion card declares none) | https://huggingface.co/Xenova/bge-small-en-v1.5 (conversion of https://huggingface.co/BAAI/bge-small-en-v1.5) | `bge-small-en-v1.5-MIT.txt` |

Notes. The Apache-2.0 text is the licence file shipped in the @huggingface/transformers package; the
Transformers.js package has no NOTICE file. The Hugging Face repositories of the two models carry no LICENSE
or NOTICE file; their licence is stated in the model card metadata (MiniLM) and on the upstream card (BGE),
and the MIT text for BGE is the FlagEmbedding repository's LICENSE (Copyright (c) 2022 staoxiao). The MIT
text for ONNX Runtime is the onnxruntime repository's LICENSE (Copyright (c) Microsoft Corporation); the
onnxruntime-web npm package ships no licence file of its own.

## Go modules vendored for the installer (`vendor/`, not part of the extension)

Versions are from `vendor/modules.txt`; each licence was read from the module's file in `vendor/`.

| Module | Version | Licence | Licence file |
|---|---|---|---|
| github.com/getlantern/context | v0.0.0-20190109183933-c447772a6520 | Apache-2.0 | vendor/github.com/getlantern/context/LICENSE |
| github.com/getlantern/errors | v0.0.0-20190325191628-abdb3e3e36f7 | Apache-2.0 | vendor/github.com/getlantern/errors/LICENSE |
| github.com/getlantern/golog | v0.0.0-20190830074920-4ef2e798c2d7 | Apache-2.0 | vendor/github.com/getlantern/golog/LICENSE |
| github.com/getlantern/hex | v0.0.0-20190417191902-c6586a6fe0b7 | BSD-3-Clause (Copyright The Go Authors; Brave New Software Project, Inc.) | vendor/github.com/getlantern/hex/LICENSE |
| github.com/getlantern/hidden | v0.0.0-20190325191715-f02dbb02be55 | Apache-2.0 | vendor/github.com/getlantern/hidden/LICENSE |
| github.com/getlantern/ops | v0.0.0-20190325191751-d70cb0d6f85f | Apache-2.0 | vendor/github.com/getlantern/ops/LICENSE |
| github.com/getlantern/systray | v1.2.2 | Apache-2.0 | vendor/github.com/getlantern/systray/LICENSE |
| github.com/go-ole/go-ole | v1.3.0 | MIT | vendor/github.com/go-ole/go-ole/LICENSE |
| github.com/go-stack/stack | v1.8.0 | MIT | vendor/github.com/go-stack/stack/LICENSE.md |
| github.com/jchv/go-webview2 | v0.0.0-20260205173254-56598839c808 | MIT | vendor/github.com/jchv/go-webview2/LICENSE |
| github.com/jchv/go-winloader | v0.0.0-20250406163304-c1995be93bd1 | ISC | vendor/github.com/jchv/go-winloader/LICENSE.md |
| github.com/oxtoacart/bpool | v0.0.0-20190530202638-03653db5a59c | Apache-2.0 | vendor/github.com/oxtoacart/bpool/LICENSE |
| golang.org/x/sys | v0.1.0 | BSD-3-Clause (Copyright The Go Authors) | vendor/golang.org/x/sys/LICENSE |

Development-only npm packages (test runners and similar) are not shipped and are not listed.
