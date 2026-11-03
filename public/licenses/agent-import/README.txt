# Agent import bundled dependencies

These packages are distributed without modification. Source and notices:

- 7z-wasm 1.2.0: git+https://github.com/use-strict/7z-wasm.git
- @file-viewer/doc 3.3.3: git+https://github.com/flyfish-dev/file-viewer.git
- @file-viewer/ppt 1.0.2: git+https://github.com/flyfish-dev/pptjs.git
- pdfjs-dist 6.5.438: git+https://github.com/mozilla/pdf.js.git
- mammoth 1.13.0: https://github.com/mwilliamson/mammoth.js.git
- jszip 3.10.2: https://github.com/Stuk/jszip.git
- xlsx 0.18.5: git://github.com/SheetJS/sheetjs.git
- ai 6.0.320: https://github.com/vercel/ai
- @ai-sdk/openai-compatible 2.0.88: https://github.com/vercel/ai
- @ai-sdk/openai 3.0.135: https://github.com/vercel/ai
- @ai-sdk/anthropic 3.0.137: https://github.com/vercel/ai
- @ai-sdk/google 3.0.140: https://github.com/vercel/ai
- idb 8.0.4: git://github.com/jakearchibald/idb.git
- zod 4.6.7: git+https://github.com/colinhacks/zod.git

7z-wasm is LGPL-2.1-or-later with the unRAR restriction. It is dynamically loaded as a replaceable WASM module. The corresponding upstream source/build scripts are available at https://github.com/use-strict/7z-wasm/tree/v1.2.0 (7-Zip source is included/referenced there). These sources may not be used to develop a RAR-compatible archiver.

- tesseract.js 7.0.0: https://github.com/naptha/tesseract.js (Apache-2.0)
- tesseract.js-core 7.0.0: https://github.com/naptha/tesseract.js-core (Apache-2.0)
- @tesseract.js-data/chi_sim and @tesseract.js-data/eng 1.0.0: https://github.com/naptha/tessdata (MIT package metadata; upstream license included in tessdata-LICENSE)

parse5 8.0.0 (MIT): basic HTML parsing for table-external annotations.
