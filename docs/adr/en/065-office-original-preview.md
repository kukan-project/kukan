# ADR-065: Draw the original of an Office document in the browser with ibisOffice (no document opened on the server, and an isolated iframe in the browser, proposed)

## Status

**Proposed** — 2026-10-11 (option I added on 2026-10-27, measured on 2026-10-29, and the
decision changed from F to I; on 2026-11-09 raised to 0.8.6, which moved DOC to the "Original" tab too)

Make Office documents (XLSX, XLS, DOCX, PPTX, PPT) viewable without relying on Microsoft's Office
Online Viewer. **Bundle ibisOffice (an office suite written in Rust and compiled to WebAssembly)
with the web app and draw the original in the viewer's browser**, through WebGPU, or WebGL2 when
that is unavailable. The server opens no document, and nothing is added to the worker or to the
artifacts. The web app hands the bytes from `/preview` to ibisOffice, which runs in a sandboxed
iframe (an opaque origin) so that it cannot reach KUKAN's cookies, API or the parent page. A document too heavy to draw is
stopped inside ibisOffice by a ceiling on its WASM memory, and the page points to the extracted
text. The "Original" tab of Office documents is ibisOffice by default; only a site that sets the
environment variable `OFFICE_PREVIEW_VIEWER` (`ibis-office` by default) to `office-online` keeps
Office Online Viewer as today. DOC, which 0.8.5 and earlier could not open, got extracted text and the
download at first; 0.8.6 opens it, so it moved to the "Original" tab.

F (a PDF made by LibreOffice in the worker) was the provisional decision at first. F opens
untrusted documents in a worker that holds credentials and network access. Settings alone
(stopping link loading and macros) cannot fully protect it, and the conversion had to move to an
environment with neither secrets nor network. Measured on the same samples (§Measurements,
"ibisOffice (I)"), I needs neither that isolation nor the image's +1.1 GB nor a conversion per
version; it draws Japanese in the device's MS typefaces, and on devices without a GPU it still
draws through WebGL2 with tables and documents usable. What I lacks (DOC, distributed alignment,
the typeface of half-width characters, view-only polish) has been requested upstream (DOC and the
alignment arrived in 0.8.6; the half-width typeface still has gaps in DOCX, open question 1).

The other ways of drawing in the browser are not adopted. LibreOffice's WebAssembly build
(ZetaOffice) needs cross-origin isolation of the whole page, 50 MB per start (cached for 20 minutes) and 1 GB of WASM
memory, and ships no CJK font, so it cannot draw Japanese. The light libraries that draw only DOCX
and PPTX (docx-preview, pptx-renderer) do nothing for XLS and XLSX, which are over 99 % of public
Office data. An in-house grid renderer and LibreOffice's HTML export fail the fidelity that
"kami-Excel" demands: borders, merges, and text spilling over cells.

## Context

### 1. The current original preview only works on a public site

`OfficeOnlinePreview` (`apps/web/src/components/preview/resource-preview.tsx`) puts
`https://view.officeapps.live.com/op/embed.aspx?src=<file URL>` in an iframe. Microsoft's servers
fetch the file, so

- a site unreachable from the internet (a local environment, a closed network such as LGWAN)
  cannot show it
- files of a private dataset cannot be shown (they cannot be fetched)
- 10 MB at most (`OFFICE_PREVIEW_LIMIT`)
- the file's content goes to Microsoft

This does not fit KUKAN's aim of running down to closed networks. The extracted-text preview
(the pre-2007 formats included) appears everywhere, but not the look of the original.

### 2. Office Online Viewer was chosen for the fidelity of kami-Excel

Spreadsheets in municipal open data are largely kami-Excel: multi-level merged headers, frames
drawn with borders, titles and notes placed in a narrow column and spilling over into the
neighbouring cells. The value of an original preview is showing these **as they are**; when any
of border weight, merges, or spilled text breaks, the reader is looking at a different thing.
Office Online Viewer got these right. A replacement must match that fidelity.

### 3. Every other format's original is already shown in-house

| Format   | How the original is shown                                                |
| -------- | ------------------------------------------------------------------------ |
| PDF      | `/preview` in an iframe (the browser's PDF view)                         |
| Images   | `<img>`                                                                  |
| Ichitaro | Drawn in the browser by EZPZ File JTD (WebAssembly) — ADR-051 decision 7 |
| CSV/TSV  | Parquet served by Range into a table — ADR-048                           |
| Office   | **Office Online Viewer (external)**                                      |

Office is the only one left on an external service.

### 4. Public Office data is almost entirely spreadsheets

Counting resources on the e-Gov data portal by format (`resource_search?query=format:<FMT>`,
2026-10-11):

| Format |   Count |
| ------ | ------: |
| XLS    | 137,876 |
| XLSX   |  13,067 |
| DOC    |      61 |
| DOCX   |      31 |
| PPTX   |      35 |

**XLS and XLSX make 99.9 %**, and the legacy XLS outnumbers XLSX ten to one. The value of an
Office original preview is decided almost entirely by spreadsheets, and Excel 97–2003 ones at
that. Documents and slides are few.

### 5. Drawing in the browser rests on three premises

- **Cross-origin isolation**: the WASM build of LibreOffice uses pthreads, so it needs
  `SharedArrayBuffer`, which needs `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` on the **top-level document**. An isolated iframe
  inside an ordinary page is not enough (measured below). KUKAN's resource page carries map tiles
  (OSM, GSI) and brand embeds, and COEP demands CORP or CORS of them too
- **Closed-network deployment**: KUKAN itself must be able to serve the static files, without a CDN
- **Fonts**: a Japanese document is drawn as tofu unless the drawing side has CJK fonts

### 6. Parts already in place

- Interpret writes "interpretation" artifacts per version (ADR-046): the document text
  (`text.ndjson.zst`), table Parquet, ZIP manifests. A PDF of the original fits the same place
- `/preview` picks a version's artifact in `resolvePreviewTarget` and serves it by Range. PDFs
  already reach the iframe this way
- The in-house BIFF reader (XLS) and officeparser (XLSX) can list a file's sheets and their used
  ranges before conversion. The choice of export mode and the sheet tab names come from there
- The worker's heavy work runs in a child process (ADR-059). A place to run an external
  executable with time and resource limits is close to that

## Options considered

### A) Keep Office Online Viewer

No cost, but the four constraints of §1 remain. Closed networks and private data keep having no
original preview.

### B) Run LibreOffice in the browser (ZetaOffice / LOWA)

LibreOffice compiled to WebAssembly, loaded from a CDN (or self-hosted), drawing into a Qt canvas.
All six formats at LibreOffice's fidelity. Measurement showed:

- The top-level document needs cross-origin isolation. Without it, startup fails with
  `SharedArrayBuffer is not defined`. **An isolated iframe inside a non-isolated page fails the
  same way.** Using it in KUKAN means isolating the whole resource page or opening a dedicated
  page in another tab
- One start's responses from the CDN come to **50 MB (brotli)**. The CDN's `Cache-Control` is
  `max-age=1200`, so the browser cache serves it for 20 minutes and it is read again after that (the
  measurement counted the responses' sizes and did not tell cache hits apart). Decoded: `soffice.wasm` 154 MB + `soffice.data` 95 MB
- **1,024 MB of WASM linear memory** is reserved at startup
- The distribution has **no CJK fonts**. Every Japanese character was drawn as tofu (layout was
  right). A custom build (LOWA) bundling fonts, or writing fonts into the virtual FS before start,
  adds tens of MB to the transfer either way
- ZetaOffice is in open beta with product terms undecided. A custom build needs pinned Qt 5 and
  Emscripten versions, and following LibreOffice releases is a heavy burden

### C) Draw with light libraries in the browser (docx-preview, pptx-renderer)

DOCX through docx-preview (Apache-2.0, 21 KB gz + jszip 28 KB gz), PPTX through
@aiden0z/pptx-renderer (Apache-2.0, 452 KB gz with echarts), into HTML/SVG. All 23 public samples
rendered; DOCX within 0.5 s, a 9 MB, 112-slide PPTX in 2.5 s. Fidelity is good for forms, reports
and slides, but

- **XLS, XLSX, DOC and PPT are out of reach** (the 99.9 % of §4)
- DOCX page breaks rely on the `lastRenderedPageBreak` Word writes, and tables laid out by
  positioning or tab stops drift (1 of 16). Wingdings bullets of an old PPTX come out as letters
  (`n`, `l`)
- The rendered HTML lands in the page, so a sandboxed iframe is needed for isolation (Ichitaro
  draws on a canvas and needed none)

A different renderer per format means different quirks per format.

### D) An in-house grid artifact (cells, merges, formats) drawn by web

Interpret writes each sheet's cell values, merges, column widths, borders and fills as an
artifact; web draws them in a virtualised grid. No LibreOffice, and spreadsheet-like handling
(tabs, scrolling) comes naturally. But reaching the fidelity of §2 in-house means reading all
formatting of XLS (BIFF XF, FORMAT, MERGEDCELLS, COLINFO) and XLSX (`styles.xml`), then writing
a renderer that sets border kinds (thin, thick, double, dashed, diagonal), vertical text,
shrink-to-fit, and **spilled text** by Excel's rules. Poor odds on both effort and fidelity.

### E) LibreOffice's HTML export in a sandboxed iframe

LibreOffice Calc's HTML export is one `<table>` per sheet, keeping borders (each side, with
weight), merges, fills and bold (measured below). But **Excel's spilling of text over cells is
not reproduced**: a long title in column A wraps vertically at the narrow column width. Titles
and notes of kami-Excel are written exactly that way, so §2 is not met. Diagonal lines (shapes)
come out as images in the wrong place. Big sheets become a huge DOM (430k cells: 240k px tall).

### F) PDF by LibreOffice in the worker, drawn in the browser (the first provisional decision, changed to I)

Interpret converts the original to PDF with LibreOffice (headless) and writes it as a version
artifact. One renderer (LibreOffice's layout engine) for all six formats, the same fidelity as B,
with spilled text and diagonal lines right (measured), but drawn once, on the server. Works on
closed networks and for private data, and the size limit is KUKAN's to set. Nothing is added to
the client beyond pdf.js.

Handing a spreadsheet to the browser's PDF viewer as "paper" is the wrong shape: sheet switching
and horizontal scrolling are lost. So spreadsheets are exported **one sheet per page** and web
draws the pages with pdf.js as sheet tabs. The costs are the worker image (+1.1 GB), conversion
time and PDF storage per version, the conversion process's memory, and pdf.js in web.

### G) A self-hosted Office Online Viewer (Collabora Online)

Collabora Online (CODE, MPL-2.0), LibreOffice inside, placed on the closed network; KUKAN adds
the two WOPI endpoints (CheckFileInfo, GetFile) and an iframe. Interactive viewing (real sheet
tabs, scrolling, zoom), the closest UX to today's Office Online Viewer. In exchange, one more
resident service (image 1.5–2 GB, memory around 1 GB). Realistic under Compose, but one more
Fargate service in the AWS multi-site setup (ADR-041 / ADR-049). Recorded as **the option when
interactive viewing becomes a requirement**; not adopted now.

### H) Interpret XLSX as a table (ADR-057)

Interpret "plain table" XLSX files as tables onto the same table preview as CSV. That is the path
to **touch the data**, not a substitute for the original's look (multi-level headers, forms and
notes are lost). Orthogonal to this ADR: F is the look, H is the data. Extremely large statistical
tables are left out of F and handed to H.

### I) Run ibisOffice in the browser — adopted (proposed; added 2026-10-27, measured 2026-10-29)

ibisOffice (ibis inc., released 2026-10-12, v0.8.x) is an office suite written in Rust, compiled
to WebAssembly and drawn with WebGPU (or WebGL2 when that is unavailable). Like B it draws in the browser, but it meets several of the
conditions B failed. What the published material and code show, and what §Measurements
("ibisOffice (I)") found:

- **Formats**: draws DOCX, XLSX and PPTX. There is a reader that turns legacy XLS (BIFF8) into
  XLSX internally (`crates/ibis-pptx/src/xls.rs`: values, formats, borders, merges, column widths,
  page setup), and a PPT reader too. **DOC does not open**: the web entry point takes .docx,
  .xlsx and .pptx, plus XLS and PPT recognised by their content; given a DOC it shows the start
  view (New, Open…) without an error. The .doc import in the conversion panel only extracts the
  body text (requested upstream, ibisjp/ibis-office#71; 0.8.6 opens it with its formatting). Rendering is said to be
  tested against PDFs exported by Office in over 70,000 pixel comparisons (the developer's figure)
- **Nothing opens on the server**: the viewer's browser draws, so the problem with F — opening
  untrusted documents in a worker that holds credentials and network access — does not arise.
  Nothing is added to the worker, and isolating the conversion, which F presupposes, is not
  needed. Parsing moves into the viewer's tab, so the defences become the browser sandbox and the
  serving origin's CSP. It runs with `connect-src 'self'`, and none of the 73 samples fetched
  anything outside
- **Embedding**: serve `www/` as static files; `view=1` gives read-only mode, and `menuBar=0` and
  `toolBar=0` remove the chrome (the parameters the official embedding guide lists). No CDN
  needed, so it can be served in closed networks. The document can be passed with `?open=<URL>`,
  but that is an undocumented playground parameter that **fetches any URL from the browser**
  (external ones too, when they allow CORS). That lets anyone craft a link that opens someone
  else's document on KUKAN's origin, so either narrow it with CSP `connect-src 'self'` or skip
  `?open=` and hand the bytes to `run()`. When CSP blocks it, the page stays at "Starting…"
  without an error. Even with `view=1`, DOCX alone shows the viewing-mode info bar with a
  "Switch to Editing" button that does nothing (ibisjp/ibis-office#72)
- **No cross-origin isolation**: the public playground runs without COOP/COEP. B's biggest
  obstacle (isolating the whole page, which spreads to map tiles and brand embeds) is absent
- **Transfer**: the WASM is 63 MB uncompressed, 16.5 MB gzipped (about 1/3 of B's 50 MB). Served
  by KUKAN itself, it can carry a long `Cache-Control` and is not re-read on later visits
- **Browsers**: it prefers WebGPU and, when no adapter is available, **falls back to WebGL2 by
  itself** (`platform.rs` in gpui-pre-web). In Chrome on Windows with the GPU turned off
  (standing in for a GPU-less virtual desktop), all 61 samples other than DOC drew through WebGL2, and tables and
  documents scrolled smoothly (§Measurements). `main.js`, however, does not try WebGL2 in a
  browser without `navigator.gpu`; it says the browser does not support WebGPU and stops. Firefox
  is unconfirmed
- **Fonts**: the web build bundles no Japanese font. Japanese and full-width characters are drawn
  by the browser's Canvas 2D, asked for by the document's font name (ＭＳ 明朝 and so on), so on
  Windows they come out in the real MS Mincho and MS Gothic. **Half-width letters and digits,
  however, are drawn in the bundled IBM Plex Sans**, even when the specified font is installed
  (requested upstream, ibisjp/ibis-office#73). Most spreadsheet values are half-width digits, so
  their typeface and widths differ from the original
- **License**: dual AGPL-3.0-only and commercial. KUKAN is AGPL-3.0 too, so bundling it unmodified
  with a pointer to its source meets the terms. The project does not accept outside PRs
- **Maturity**: two weeks since release, v0.8.x. Read-only embedding is provided, but there is no
  view-only build (a smaller WASM without the editing features)

Compared with F, the worker image (+1.1 GB), per-version conversion time and PDF storage, and
isolating the conversion all go away. In exchange it asks the viewer's device for WebGPU or WebGL2 and a
first transfer of tens of MB, and entrusts rendering fidelity to a young external project.
Spreadsheets get sheet tabs, scrolling and zoom out of the box, so F's remaining work (the pdf.js
sheet viewer) is not needed either.

Fidelity, start-up time, memory and outside fetches are as in §Measurements ("ibisOffice (I)").

## Measurements (2026-10-11; I on 2026-10-29)

### Samples

73 public files (PDL1.0 / CC BY) picked per format through the e-Gov data portal's CKAN API: DOC 12,
DOCX 16, PPTX 7, XLS 16, XLSX 16, and PPT 6 (the portal lists no small PPT, so picked PPTX files
were saved as PPT by LibreOffice; not PowerPoint-authored). The largest are a PPTX of 8.8 MB and
112 slides and an XLSX of 1.4 MB and 430k cells. The measurement harness is in `spike/adr-065/` (without the samples or results); this ADR holds the figures.

### Light libraries (C)

Chromium (Playwright); render time is around the library call.

| Format | Rendered | Render time median / max | DOM nodes max |
| ------ | -------- | -----------------------: | ------------: |
| DOCX   | 16/16    |           50 ms / 454 ms |         7,465 |
| PPTX   | 7/7      |        190 ms / 2,071 ms |        22,714 |

### ZetaOffice (B)

Loaded from the CDN (`cdn.zetaoffice.net/zetaoffice_latest/`) over a line of several hundred Mbps.

| Item                                            |                              Value |
| ----------------------------------------------- | ---------------------------------: |
| Startup (cold / warm)                           |                      5.1 s / 4.4 s |
| Responses from the CDN (one start, 6 responses) |                     50 MB (brotli) |
| WASM linear memory (right after start)          |                           1,024 MB |
| Non-isolated top-level page                     |  No start (no `SharedArrayBuffer`) |
| Isolated iframe inside a non-isolated page      |                      Also no start |
| Opened                                          |                              73/73 |
| Open time median (per format)                   |                          0.5–0.9 s |
| Open time max                                   |   44.6 s (PPTX 8.8 MB, 112 slides) |
| Japanese                                        | **Tofu throughout** (no CJK fonts) |

### Native LibreOffice (F)

LibreOffice 25.8.7 on `node:24-alpine` (the worker's base) through `apk add libreoffice-writer
libreoffice-calc libreoffice-impress font-noto-cjk`. One process per file,
`soffice --headless --convert-to pdf`; memory is `soffice.bin`'s VmHWM sampled every 0.1 s.

| Item                        |                          Value |
| --------------------------- | -----------------------------: |
| Image growth (/usr)         | **+1,095 MB** (162 → 1,257 MB) |
| of which LibreOffice itself |                         364 MB |
| of which Noto CJK           |                          89 MB |

| Format | Converted | Time median / max | Pages median / max | Peak memory median / max |
| ------ | --------- | ----------------: | -----------------: | -----------------------: |
| XLS    | 16/16     |   0.32 s / 0.74 s |             2 / 21 |          155 MB / 182 MB |
| XLSX   | 16/16     |   0.43 s / 10.4 s |            8 / 215 |          173 MB / 348 MB |
| DOC    | 12/12     |    0.42 s / 4.6 s |             3 / 34 |          218 MB / 414 MB |
| DOCX   | 16/16     |    0.53 s / 3.9 s |             4 / 75 |          219 MB / 273 MB |
| PPT    | 6/6       |     2.6 s / 6.2 s |            3 / 112 |          203 MB / 332 MB |
| PPTX   | 7/7       |    3.2 s / 15.2 s |            4 / 112 |          235 MB / 801 MB |

- Japanese comes out right with Noto CJK. The table whose rows drifted in docx-preview, and the
  title the HTML export wrapped vertically, were both set correctly
- The first start takes a few seconds to create the user profile; not a per-process cost

### How spreadsheets are exported (the crux of F)

The normal export paginates by the Excel **print setup** saved in the file (paper, scaling,
print area, title rows, hidden rows and columns). `SinglePageSheets` ignores scaling and page
breaks and makes one page per sheet, sized to the used range.

| Sample               | Normal: pages / size | One sheet per page: size (pt) / real size / time / bytes |
| -------------------- | -------------------: | -------------------------------------------------------: |
| 430k-cell table      |       8 (A4) / 16 MB |     9,266 × 10,401 / about 3.3 m × 3.7 m / 18 s / 0.5 MB |
| 45k-cell tall table  |      215 (A4) / 9 MB |     126 × 14,384 / 4 cm wide × 5 m tall / 5.6 s / 1.1 MB |
| One column, 11k rows |     18 (A4) / 2.4 MB |               394 × 13,434 / 4.7 m tall / 1.0 s / 0.5 MB |
| 35-sheet summary     |    64 (A4) / 11.5 MB |             700–1,480 × 880 / around A3 / 2.6 s / 0.7 MB |

- The normal export reads well when the author set it up for printing and comes out in strips
  otherwise. The 430k-cell table had "fit to one page" set and became 8 pages of tiny type
- One sheet per page grows the page up to **around 14,400 pt (the practical PDF limit, about
  5 m)**. The 45k-cell table stopping at 14,384 pt looks like clamping; whether it was scaled or
  cut at the bottom is unverified
- **PDF size does not depend on the page's dimensions.** Being vector, it is decided by the
  number of drawn objects, and one sheet per page is an order of magnitude smaller than the normal
  export (430k cells: 16 MB → 0.5 MB). The normal export presumably grows because resources are
  repeated per page; not verified inside. What really grows a PDF is sheets full of images and
  shapes, the same either way
- Size is not the worker's problem but **the browser's: how to draw one enormous page**. The work
  and canvas memory pdf.js needs depend on the visible region's extent and the objects in it
- `SinglePageSheets` is a **per-document** option; it cannot be chosen per sheet

### ibisOffice (I)

The same 73 files, opened in ibisOffice 0.8.4's web build (the same `app/` as the playground).
Served as KUKAN would serve it, from its own server (gzip, a year's `Cache-Control` on `pkg/`),
with the document passed from the same origin; `view=1&menuBar=0&toolBar=0`, 1280 × 860. Times
are from the start of navigation: start-up until `run()` returns, drawn when 300 ms of no frames
follow the first frame (the blinking caret keeps redrawing after that). Two conditions:

- **Real GPU**: Chrome 156 on Windows 11, an NVIDIA GPU (Ampere generation), drawing through WebGPU
- **No GPU**: the same Chrome started with `--disable-gpu` (standing in for a GPU-less virtual
  desktop). No WebGPU adapter; everything drew through WebGL2 (in software; the 12 DOC files do not open)

| Format | Opened | Drawn, median / max (real GPU; no GPU) | WASM memory, max (real GPU / no GPU) | Process memory, max renderer / GPU (real GPU) |    Same (no GPU) |
| ------ | ------ | -------------------------------------: | -----------------------------------: | --------------------------------------------: | ---------------: |
| XLS    | 16/16  |            0.88 / 0.97 s; 0.68 / 1.3 s |                           39 / 41 MB |                                  228 / 377 MB |     259 / 694 MB |
| XLSX   | 16/16  |             0.95 / 1.6 s; 0.69 / 1.2 s |                         223 / 223 MB |                                  399 / 264 MB |     423 / 462 MB |
| DOC    | 0/12   |                                      — |                                    — |                                             — |                — |
| DOCX   | 16/16  |             0.64 / 1.2 s; 0.69 / 1.1 s |                           52 / 52 MB |                                  238 / 258 MB |     264 / 390 MB |
| PPT    | 6/6    |               1.5 / 2.6 s; 1.4 / 3.5 s |                         545 / 804 MB |                                  817 / 741 MB | 1,065 / 1,076 MB |
| PPTX   | 7/7    |               1.6 / 2.8 s; 2.2 / 3.9 s |                         545 / 805 MB |                                  835 / 803 MB | 1,060 / 1,166 MB |

| Item                                                               |                                                              Value |
| ------------------------------------------------------------------ | -----------------------------------------------------------------: |
| WASM transfer (gzip)                                               |                                                              16 MB |
| Cold start (no cache, real GPU)                                    |                                     start-up 0.63 s / drawn 0.87 s |
| Warm start (second document on, until `run()` returns)             |                                                        about 0.3 s |
| Frame gap while scrolling, median (real GPU)                       |                     tables and documents 34–41 ms, slides 83–84 ms |
| Same (no GPU, WebGL2)                                              |                   tables and documents 67–68 ms, slides 116–195 ms |
| Requests leaving the origin                                        |                                                            0 of 73 |
| CSP (`connect-src 'self'`, `script-src 'self' 'wasm-unsafe-eval'`) | runs (the only violation is `index.html`'s inline language script) |

- **Appearance**: kami-Excel's diagonal and double borders, merges, vertical text, frozen panes
  and XLS sheet tabs came out as in the original (by eye; no pixel comparison). Japanese is drawn
  in the viewer's own fonts, half-width letters and digits in IBM Plex Sans (§I). **Distributed
  horizontal alignment does not take effect**, however: the text is drawn packed, where centred
  text would be (XLS and XLSX alike, ibisjp/ibis-office#75). Government tables often use it for
  headings and item names, and here F (LibreOffice) matches the original
- **Against F**: side by side with F's PDFs of the same samples, I is closer to the original in
  typeface (F sets everything in Noto Sans CJK, a Gothic face; I uses the real MS Mincho and MS
  Gothic on Windows) and in diagonal borders (missing from F's PDF in some samples), while F
  matches the original in distributed alignment
- **Drawing time hardly depends on the GPU.** Most of it is loading and laying out the document;
  the GPU matters for smoothness while operating, such as scrolling. With a real GPU, 30 wheel
  steps were handled in about 3 s for every format, as fast as they were sent. Without a GPU,
  tables and documents kept up too (about 3 s, around 15 fps), while slides took 4.5–10 s. Forcing
  WebGPU onto software (SwiftShader) with a flag is slower than WebGL2: the same took 12–60 s
  (Chromium 151 on Linux)
- **Slides are heavy**: WASM memory up to 545 MB (805 MB without a GPU), and the renderer and GPU
  processes about 800 MB each (about 1,100 MB without a GPU). Tables and documents stay within
  200–400 MB with a real GPU (without one, an XLS took the GPU process to 694 MB)
- **DOC**: all 12 showed the start view (§I)
- **Image pixels** (the dimensions of the images in `media/`, summed) peaked at 61.8 MP (a slide
  deck of 40 images), with 2.6 MP for the largest single image. The slide deck with the largest WASM
  memory, 545 MB, had 7.2 MP of images; memory did not follow pixel count
- **In an isolated iframe** (`sandbox="allow-scripts"`, the document passed with `postMessage`) it
  drew the same with WebGPU and WebGL2. Inside the iframe, cookies, localStorage and the parent DOM
  threw SecurityError, and a fetch outside was stopped by CSP. With an opaque origin, the
  distribution needed `Access-Control-Allow-Origin: *`
- **A fetch to the same server reaches it** even though it looks like a failure to the iframe's
  script: CORS stops reading the response, not sending the request. Recorded on the server, with
  `connect-src 'self'` the request arrived without the cookie when the parent page's cookie was
  SameSite=Lax, and **with the cookie** when it was SameSite=None. With `connect-src` narrowed to
  ibisOffice's distribution path, nothing arrived
- **The iframe navigating itself** is not stopped by CSP's `connect-src`. Navigating the iframe to
  another origin with `location.href` delivered the first bytes of the document, carried in the
  URL, to a stand-in outside server. With `frame-src 'self'` on the parent page, the same
  navigation was blocked as violating frame-src and nothing arrived (Chromium 151). With
  `frame-src` narrowed to the boot page's path, navigating to another URL on the same origin
  (`/whoami?document=…`) was blocked too
- **WebRTC** works inside the sandboxed iframe: the boot page's own code reached a stand-in TURN
  server's UDP port with `RTCPeerConnection`. Inside the iframe, however, `eval` and
  `new Function` threw EvalError under the CSP (no `'unsafe-eval'`). With the WebRTC globals
  removed by the boot page, creating a child iframe to fetch them again from a fresh realm threw
  SecurityError (Chromium 151)
- **DNS prefetching**. Appending `<link rel="dns-prefetch">` to the boot page afterwards, asking for a
  name that could carry the document, caused no name resolution in Chromium 151 (checked in the
  network log). The same on an ordinary page caused none either, so this approach cannot show the
  effect of `X-DNS-Prefetch-Control: off`. The header is sent as a safeguard for other browsers and
  versions
- **A generic bridge among the imports**. None of the 809 JS functions ibisOffice's WASM imports is
  for WebRTC, but they include one that gets `globalThis`, `Reflect.get` and `Reflect.set`, a `call`
  that invokes any function, and `createElement` and `appendChild`; together they reach most JS
  APIs without `eval`. The imported `eval` is stopped by the CSP
- **The isolated iframe gets no HTTP cache.** When the boot page (an opaque origin) fetched the
  WASM, the server saw a request on every load (two loads, two requests). On an ordinary page, the
  second load came from the cache (two loads, one request)
- **A ceiling on WASM memory.** With a maximum written into the WASM's memory declaration by the
  boot page, a 430k-cell sheet (223 MB without a ceiling) stopped at a 64 MiB ceiling with
  `RuntimeError: unreachable`, without taking the tab down, and the failure reached the parent. At
  256 MiB the heavy slide deck (545 MB without a ceiling) fitted in 229 MB and drew. Without a
  ceiling the WASM appears to reserve generously when it can

### Verdict

| Aspect                  | B ZetaOffice                       | C light libraries | D in-house grid | E HTML export    | F LibreOffice PDF         | G Collabora      | I ibisOffice                                                                 |
| ----------------------- | ---------------------------------- | ----------------- | --------------- | ---------------- | ------------------------- | ---------------- | ---------------------------------------------------------------------------- |
| Formats                 | 6                                  | DOCX, PPTX only   | XLS, XLSX       | XLS, XLSX        | 6                         | 6                | 6 (DOC from 0.8.6)                                                           |
| Kami-Excel fidelity     | LibreOffice                        | —                 | reimplemented   | spill breaks     | LibreOffice               | LibreOffice      | borders, merges and distributed alignment as original (alignment from 0.8.6) |
| Japanese                | Tofu (fonts to add)                | OK                | OK              | OK               | OK                        | OK               | the device's fonts (MS Mincho on Windows)                                    |
| Closed network, private | OK if self-hosted                  | OK                | OK              | OK               | OK                        | OK               | OK (self-hosted)                                                             |
| Client cost             | 50 MB (cached 20 min), 1 GB memory | 50 KB–450 KB      | a grid          | huge DOM         | pdf.js                    | iframe           | 16 MB first time, 200–1,100 MB, WebGPU or WebGL2                             |
| Effect on the page      | COOP/COEP on the top level         | sandboxed iframe  | none            | sandboxed iframe | none                      | none             | none (iframe, CSP narrows fetches)                                           |
| Server cost             | None (CDN) / 250 MB static         | none              | reader work     | image +1.1 GB    | image +1.1 GB, conversion | one more service | none (63 MB static)                                                          |
| Distribution terms      | Beta, undecided                    | Apache-2.0        | —               | MPL-2.0          | MPL-2.0                   | MPL-2.0          | AGPL-3.0 / commercial, v0.8.x                                                |

With XLS and XLSX at 99.9 %, C is no answer. None of B's premises is light. D and E fail the
fidelity of §2. F keeps its cost on the server and fits the same "interpretation artifact" as the
other formats. G is the next step if F proves insufficient.

I removes all of F's costs (image +1.1 GB, per-version conversion and PDFs, isolating the
conversion). On a device with a real GPU it draws tables and documents in about a second and
scrolls smoothly, and on Windows the Japanese text comes out in the real MS typefaces. Devices
without a GPU still draw through WebGL2, and tables and documents remain usable. In 0.8.4, as
measured, DOC did not open, distributed alignment was lost and half-width letters and digits came out in a
substitute typeface; 0.8.6 fixed DOC and the alignment, and the
half-width typeface in XLSX (what remains in DOCX is open question 1). Rendering fidelity and the view-only polish (the info bar in §I) are left to an upstream
project two weeks old.

I is adopted. F's hard part — opening untrusted documents on the server — disappears by
construction, and I is also ahead in fidelity (typefaces, diagonal borders) and in how light it is
to operate, and in the browser too it can be isolated in a sandboxed iframe. I's gaps are requested
upstream and accepted, with a per-site setting to go back to Office Online Viewer as the way out. If I stalls
(upstream stops, or closed-network devices cannot draw it), the next step is F, and this ADR keeps
F's measurements and open questions for that.

## Decision (proposed)

### 1. Serve ibisOffice's web build, unmodified, from the web app

Serve ibisOffice's web build (the JS and WASM in `pkg/`, plus assets such as icons) as static files
on the same origin as KUKAN's web app, under a path that includes the version
(`/vendor/ibis-office/<version>/`), with a year's `Cache-Control` (immutable) and
`Access-Control-Allow-Origin: *` (so the isolated iframe can read it, decision 2). At runtime no
CDN is involved, so it works the same in closed networks.

**Source.** The web build attached to upstream's releases (`ibisOffice-<version>-Web.zip`, from
0.8.5 on, added in response to ibisjp/ibis-office#76) is used. KUKAN's repository holds not the zip but
`apps/web/vendor/ibis-office/manifest.json`, with the version and SHA-256; the web dev and build
scripts fetch the zip, check it, and unpack it into `apps/web/public/vendor/ibis-office/<version>/`
(both gitignored). Upstream says a published release's files do not change, but the SHA-256 is
checked rather than relying on that. The running service never goes to GitHub. The 3,000-odd
unpacked files (the WASM is 65 MB) go neither into the repository nor into turbo's cache.

The zip is not committed because upstream moves fast (0.8.5 a little over two weeks after release),
and each upgrade would leave about 32 MB in the history for good (0.8.4 alone, when releases had no
web build, was committed as a tar.gz for a time and remains in the history). In exchange, the build
has to reach GitHub. On a closed network that cannot, putting the same zip in
`apps/web/vendor/ibis-office/` beforehand means it is not fetched.

Nothing is kept against upstream removing its releases or repository. It is unlikely, and if it
happens, running sites and built images keep working, and a zip at hand can rebuild them. The
corresponding source could no longer be pointed to, so unless another source is arranged, the
default viewer goes back to Office Online Viewer. A site can avoid it at any time with
`OFFICE_PREVIEW_VIEWER=office-online`. Keeping a copy (of the six gpui submodules as well as the
main repository) would not be worth the upkeep.

**Delivery.** CloudFront gets a `/vendor/ibis-office/*` behaviour with long-lived caching that does not key on
cookies or locale (today these files fall into the HTML behaviour, expire after five minutes, and
signed-in viewers fetch them from the web task every time). The WASM is not precompressed: Next
gzips it on the fly (63 MB to 16.4 MB, measured on 0.8.4). CloudFront does not compress objects over 10 MB itself, but
caches the gzipped response at the edge. Precompressing would bring it to 10.1 MB with brotli, but
needs a way to pick the file by `Accept-Encoding`, and saves only each viewer's first fetch (it is
cached for a year), so it is left out for now (open question 5). Compose's Caddy also gets wasm in
its compression list.

**Licence and attribution.** As with EZPZ for Ichitaro (ADR-051), `LICENSE`, `NOTICE` and `SOURCE`
sit beside it; the zip holds none of them, so they live in the repository. `SOURCE` records the zip
it comes from and the corresponding source (upstream's tag and the submodule commits). ibisOffice is
dual-licensed AGPL-3.0-only and commercial; KUKAN is AGPL-3.0 too, so serving it unmodified,
keeping upstream's `LICENSE` and `NOTICE`, and making the corresponding source obtainable meets the
terms. The AGPL leaves it to whoever conveys the code to keep the source available wherever it is
hosted; what happens if upstream disappears is in the Source paragraph above.

ibisOffice's `NOTICE` carries an additional term under AGPL-3.0 section 7(b): a service that
includes ibisOffice must display "Powered by ibisOffice" with a link to
https://github.com/ibisjp/ibis-office in its user interface (`docs/TRADEMARK.md` marks this as
required). The embedded viewer hides the menu bar, so ibisOffice's own "About" screen is not
visible; KUKAN therefore shows that text and link next to the viewer in the "Original" tab. This
follows the Ichitaro preview, which shows "Powered by EZPZ File"; it uses text only, not
ibisOffice's logo (the name and logo are trademarks).

### 2. Boot in an isolated iframe, handing over bytes

ibisOffice's `index.html` and `main.js` are neither used nor served (so the playground, which
opens whatever `?open=` URL it is given, is not on KUKAN's origin). The web app has a small boot page that calls
`init`, `set_embed_options` and `run` from `pkg/` directly. The boot page goes in **an iframe with
`sandbox="allow-scripts"`** (no `allow-same-origin`). Documents are untrusted input; even if
ibisOffice's parsing has a flaw, nothing inside the iframe can use the authority of KUKAN's origin.

**The premise.** The JS functions ibisOffice's WASM imports include a generic bridge: one that gets
`globalThis`, `Reflect.get` and `Reflect.set`, a `call` that invokes any function, `createElement`
and `appendChild` (§Measurements). A compromised WASM is assumed to reach most JS APIs in the iframe
without `eval`. The defence therefore rests not on a short import list but on the following.

- **The boot page**
  - It is a static file that never redirects and returns the same 200 for any query. It does not
    change its behaviour by query (`frame-src` can only narrow by path, so code inside the iframe
    can navigate back to the boot page's path with any query it likes)
  - Its response CSP includes `sandbox allow-scripts`, so even when opened directly outside an
    iframe it runs in an opaque origin, without the authority of KUKAN's real origin
  - It accepts the document only when `window.parent !== window`, the message `isTrusted`, and its
    `source` is `window.parent`
  - The two functions ibisOffice calls (`ibisOfficeEmbedAction`, `ibisOfficePickFile`) are defined
    as no-ops (upstream's `main.js` posts download bytes to the parent)
  - It removes WebRTC (`RTCPeerConnection` and its kin) before loading ibisOffice. A static
    `import` is evaluated before the body, so it removes them first and loads with `import()`
  - **It puts a ceiling on WASM memory** (decision 3)
- **The boot page's CSP allows only the boot page's and ibisOffice's distribution paths**, not all of
  `'self'`. CORS only stops the response being read; the request still reaches KUKAN, with the
  session cookie if that cookie is SameSite=None (§Measurements). KUKAN's session cookie is Better
  Auth's default Lax today, but this does not rely on it. DNS prefetching is turned off too
  (`X-DNS-Prefetch-Control: off`). `<A>` stands for `/vendor/ibis-office/<version>/` (the boot
  page sits in the same directory as ibisOffice). A CSP source needs the host, so it is written
  with the site's public origin (`BETTER_AUTH_URL`) and the other names the operator lets people
  sign in under (`TRUSTED_ORIGINS`). Neither the request's `Host` nor `X-Forwarded-Host` is used:
  CloudFront passes a viewer's `X-Forwarded-Host` on, which would put someone else's host in the
  HTML cache, and the `Host` it sends is the internal ALB's name, which would show the setup in an
  unauthenticated response (ADR-070). Without CloudFront, `Host` is still the sender's to choose,
  and a shared cache in front would serve it to others. So a site opened directly under a name in
  neither, such as its address, has the frames of the original's and the PDF's previews stopped by
  the CSP; a name to be used is added to `TRUSTED_ORIGINS`

  ```
  sandbox allow-scripts; default-src 'none'; script-src <A> 'wasm-unsafe-eval';
  connect-src <A>; img-src <A> data: blob:; style-src 'unsafe-inline';
  font-src <A> data:; frame-ancestors 'self'
  ```

- The sandbox gets `allow-scripts` only, not `allow-top-navigation`, `allow-popups` or
  `allow-forms`: navigating the parent, new windows and form submissions are all ways out
- **The iframe's own navigation is stopped too.** `connect-src` stops only connections, not the
  iframe navigating itself to an outside URL with `location.href` (which can carry the document in
  the URL; reproduced in §Measurements). The parent page's CSP therefore gets `frame-src`, limited
  to the boot page's path. `frame-src` goes on **every page**: datasets are mostly reached from the
  home or search cards through Next's `<Link>`, and the App Router does not replace the document
  when moving between pages, so the CSP in force is the first document's (a header on dataset pages
  alone would not apply when entering from another page). `OFFICE_PREVIEW_VIEWER` is a runtime
  variable, so it is emitted **per request** by middleware rather than by `next.config.ts`'s
  `headers()`, which is fixed at build time. It allows the boot page's path, same-origin PDF display
  (`/api/v1/resources/…/preview`), and Office Online Viewer's host only on `office-online` sites
  (allowing it on `ibis-office` sites would let code in the iframe hand an outside URL to
  Microsoft's viewer and have its server fetch it). Those two are the only iframes in the web app
  today (PDF display and Office Online Viewer)
- **What the parent hands over**
  - The parent fetches the document from `/preview` and posts its bytes and file name with
    `postMessage`. `?open=` is not used: it fetches any URL, so it would let anyone craft a link that
    opens someone else's document on KUKAN's origin (§I)
  - **The parent also fetches ibisOffice's WASM and passes it in.** Fetches from the isolated iframe
    (an opaque origin) are not kept in the browser's HTTP cache, so every load would fetch 16 MB
    again (§Measurements); the parent's fetch is cached. Only the boot page's JS (170 KB) is loaded
    by the iframe itself
  - A given iframe gets the document once; a re-navigated page saying `boot` again gets nothing
    more (posting again would let compromised code navigate repeatedly and take the document out bit
    by bit)
  - The parent accepts messages only from its own iframe's `source`, and drops everything except
    `boot`, `ready` and `error`
- `set_embed_options`: view-only (`view`), no menu bar or tool bar, no close or download buttons.
  Downloads use KUKAN's resource page
- `main.js`'s WebGPU check (stopping when `navigator.gpu` is absent) is not carried over.
  ibisOffice switches to WebGL2 by itself when WebGPU is unavailable. If neither works and `run()`
  fails, the boot page tells its parent, which says in the "Original" tab that it could not be
  drawn and points to the extracted text (as the Ichitaro original does; switching tabs silently
  would leave no reason for the original's disappearance). Once it has drawn, only a WASM trap
  (out of memory, a panic) counts as failure: copying fails, as the iframe has no clipboard
  permission, and must not take away an original already drawn
- **What remains.** WebRTC is removed, and fetching it again from a child iframe's fresh realm is
  blocked by SecurityError in Chrome (§Measurements). Other browsers' behaviour and channels not yet
  known are accepted, since they presuppose a full compromise of the WASM; what could leave is the
  one document that viewer is allowed to see

### 3. The "Original" tab is ibisOffice by default, and only one runs at a time

The "Original" tab for XLSX, XLS, DOCX, DOC, PPTX and PPT becomes ibisOffice. The viewer that draws the
original is chosen with the web environment variable `OFFICE_PREVIEW_VIEWER`.

| Value                   | Draws the original              |
| ----------------------- | ------------------------------- |
| `ibis-office` (default) | ibisOffice (in the browser)     |
| `office-online`         | Office Online Viewer (as today) |

It is a value rather than a switch so that another renderer (F's PDF, say) only needs another
value. Office Online Viewer gets no switch of its own: with `ibis-office` it is not used, so a
closed network never sends anything out to it. Existing sites switch to ibisOffice by default on
upgrade (with 0.8.5, public DOC files lost their original view; 0.8.6 brought it back), which the
release notes must say.

| Format                                     | `ibis-office` (default)              | `office-online` |
| ------------------------------------------ | ------------------------------------ | --------------- |
| XLSX, XLS, DOCX, DOC, PPTX, PPT            | Original: ibisOffice; extracted text | as today        |
| Documents failing the pre-check            | extracted text and the download      | as today        |
| Link resources whose file was never stored | extracted text (if any) and the link | as today        |

- **The original is shown for private and draft datasets too.** Today an Office document in a
  private dataset gets extracted text only (Office Online Viewer has Microsoft's servers fetch the
  file, so a private file cannot be given to it). ibisOffice draws in the browser of a user allowed
  to view it, from `/preview` (with the same access check as the download), so the document never
  leaves. On `ibis-office` sites, users who can see the dataset (signed in, with permission) get
  the original even when it is private or a draft
- **The main guard is a ceiling on WASM memory.** ibisOffice is a full office suite and reads more
  formats and image kinds (down to ICO, TGA, PNM, HDR, EXR and animations) than KUKAN's readers.
  Counting all of that before drawing is not possible, so KUKAN does not try. Instead, before
  assembling the WASM, the boot page writes a maximum into its memory declaration (it is wasm32 and
  declares none). Whatever the cause — images, fonts, content weight — the heap cannot grow past it;
  ibisOffice fails inside and the parent points to the extracted text. In §Measurements, a 64 MiB
  ceiling stopped a 430k-cell sheet with a `RuntimeError` without taking the tab down, and at
  256 MiB the heavy slide deck (545 MB without a ceiling) still fitted and drew. The ceiling is set
  around 1 GiB, measured during implementation, and is a code constant
- **The checks before drawing are kept to the cheap and certain** (stopping ZIP bombs and pointless
  fetches)
  - If the size in the resource's metadata or the `Content-Length` of `/preview` exceeds 64 MB, the
    file is not fetched; the fetch itself is counted as it streams and stops past 64 MB
  - The bytes are split by their leading signature, not the declared format (newer-format files are
    often published with legacy extensions, and `formats.ts` accepts the ZIP signature for XLS and
    PPT). Anything that is neither a ZIP (`PK\x03\x04`) nor a compound file (`D0 CF 11 E0`) is not
    handed over
  - Only a plainly built ZIP passes: the end of central directory record (EOCD) at the very end of
    the file with an empty comment, local headers running from the start with no gaps and agreeing
    with the directory (name bytes, method, size, encryption flag), no encrypted entry, no duplicate
    name, at most 10,000 entries. This keeps out tricks that read differently from one reader to the
    next (bytes before or after, headers disagreeing with the directory). Of 82 public Office
    documents, none was refused by this
  - A ZIP is decompressed entry by entry as a stream in a Web Worker (`DecompressionStream`),
    counting the output and discarding it, and stops once the expanded total exceeds 128 MB or 10 s
    pass. Sizes written in the directory are not trusted
  - An Office compound file gets no check beyond its size and signature; tricks in its structure are
    caught by the WASM memory ceiling. The Ichitaro original uses the same parts (the fetch limit, the
    signature, the memory ceiling, the crash mark, starting when in view), with its values in ADR-051
    decision 7
- **Why 128 MB.** Tables and documents are mostly XML, and WASM memory grew at 8 to 16 times the
  expanded size (16 MB to 223 MB for a 430k-cell sheet, 3.2 MB to 52 MB for a document, 70.4 MB to
  590 MB for a large public sheet, §Measurements). About 70 to 120 MB expanded fits in 1 GiB, and the
  first choice of 64 MB refused a public document (70.4 MB) that opens. What this stops is a ZIP
  bomb; a document that is merely heavy is stopped by the memory ceiling, so 128 MB leaves room. The
  64 MB on the file itself is there to avoid a useless fetch, four times the largest public sample
  (16 MB)
- **Beyond that, nothing is bounded.** Memory used outside the WASM — what ibisOffice hands to the
  browser's own image decoder, and GPU memory — is not covered by the ceiling. If memory runs out
  the viewer's tab goes down, and since the GPU process is shared between tabs, drawing in other
  tabs may falter for a moment too (the browser restarts the GPU process itself). KUKAN's data and
  authority are out of reach. Only people with publishing rights can put files up, and a crashed
  document is not opened again thanks to the mark in the next item, so this is accepted
- **A document that crashed is not opened again**
  - Before the document goes to the iframe, a mark for its **version** goes into localStorage, and is
    removed when the iframe is removed and when the page goes away (`pagehide`); a crash does
    neither. If the mark is still there next time, the page opens on the extracted-text tab. The
    "Original" tab stays, to try again by pressing it
  - It is not removed when drawing finishes. ibisOffice opens its window, draws for the first time
    and uploads to the GPU after `run()` has returned, and running out of memory outside the WASM
    takes the tab down after that
  - The boot page reports when `run()` returns. If no report comes within a set time (around 30 s,
    counted only while in sight), the parent removes the iframe and points to the extracted text.
    The browser stops drawing in a hidden tab or a frame scrolled away, so a missing report there
    says nothing about the document
  - So that two tabs on one document are not confused, each tab keeps its own key (version and tab
    ID) and adds the time every few seconds while the document is open (a heartbeat). Another tab's
    mark with a recent time is taken as open; only a mark that has gone stale counts as a crash
  - The tab ID is kept in sessionStorage. Reloading a crashed tab straight away finds its own mark
    still there, even while a mark from another tab would still look recent
  - A hidden tab's timers slow until its heartbeat looks stopped, so it holds no mark while hidden. A
    document that crashes a hidden tab leaves none, but does when it next crashes one in view
  - sessionStorage alone would not do: closing a crashed tab and opening it again loses it. The mark
    expires after one day, and then the original is tried again. Pressing "Original" replaces stale
    marks. A browser without storage works without marks. The mark stays in that viewer's browser and
    nothing is recorded on the server
- The WASM is loaded only when the "Original" tab comes into view (16 MB the first time, then from
  the parent's cache), and after the boot page has reported, so not for a frame the CSP blocked
- **Only one ibisOffice runs at a time.** The dataset page keeps every resource preview and every
  tab once opened (so as not to reload Office Online Viewer). ibisOffice uses hundreds of MB to
  1 GB each, so it is the exception: moving to another resource or tab removes its iframe and
  returns the memory, and coming back boots it again (the WASM is passed from the parent's cache and
  assembled again in the iframe)
- The extracted-text tab stays. An original drawn on a canvas cannot be read aloud, so assistive
  technology reads this one

### 4. Nothing is added to the worker, the artifacts or existing data

Drawing happens in the browser at each view, so there is no Interpret step and no artifact.
Existing resources show their original as soon as the site is on `ibis-office`, with no reprocessing.
LibreOffice is not added to the worker image, and the implementation that assumed F
(`OFFICE_PDF_ENABLED`, `/preview?view=print`, the `soffice` child process) is not built.

### 5. Not adopted

- **F (LibreOffice PDF)**: see §F and §Verdict. Kept as the next step if I stalls
- **ZetaOffice / LOWA**: see §B. Cross-origin isolation of the whole page spreads to map tiles and
  brand embeds
- **docx-preview / pptx-renderer**: confirmed to work, but ibisOffice draws DOCX and PPTX too
- **In-house grid, HTML export**: see §D and §E; they fail kami-Excel fidelity
- **Collabora Online**: see §G. Revisit if interactive viewing becomes a requirement
- **Editing in ibisOffice**: it is embedded view-only. Editing belongs to the Data Editor (ADR-007)

## Consequences

- **web**: the isolated iframe's boot page (a static file, `sandbox` in its CSP, assembling the
  WASM with a memory ceiling written in), the parent fetching and handing over the document and the
  WASM, the checks before drawing (Web Worker), the crash marks, switching the "Original" tab,
  running only one at a time (an exception to keeping opened previews), `frame-src` on
  every page (per request, by middleware), and "Powered by ibisOffice" with its link next to the viewer
- **Environment variable**: `OFFICE_PREVIEW_VIEWER` (web, `ibis-office` or `office-online`,
  `ibis-office` by default), defined in `packages/shared/src/env.ts` and passed from Compose and
  CDK (per site)
- **Build**: a script that fetches, checks and unpacks upstream's zip, the Dockerfile's web stage
  (image +65 MB)
- **Delivery**: a `/vendor/ibis-office/*` behaviour on CloudFront, wasm in Compose's Caddy compression list.
  Under ADR-068 (running web on Lambda), the function zip grows by the WASM and a cache miss becomes
  a Lambda response
- **api, worker**: no change (`/preview` stays as it is)
- **Docs**: the administrator guide (setting `OFFICE_PREVIEW_VIEWER`, supported
  browsers), the release notes (the default becomes ibisOffice; DOC returns to the
  original view with 0.8.6), the matrix in CLAUDE.md (the preview column), third-party notices

## Open questions

1. **Upstream gaps**: DOC does not open (ibisjp/ibis-office#71); DOCX shows the viewing-mode info
   bar even with `view=1` (ibisjp/ibis-office#72); half-width letters and digits come out in IBM
   Plex Sans (ibisjp/ibis-office#73); distributed alignment has no effect (ibisjp/ibis-office#75).
   The version was raised to 0.8.6 and DOC moved to the "Original" tab. Checked on screen, two gaps
   remain. DOC and older DOCX files still show the compatibility-mode info bar ("Convert to the
   latest format") with `view=1` (ibisjp/ibis-office#139). Half-width letters and digits take the
   given typeface in XLSX, but in DOCX only serif faces do; sans-serif and monospace faces still come
   out in the substitute (findings added to ibisjp/ibis-office#126). DOC's layout is not yet as
   accurate as DOCX's (upstream says it keeps improving it)
2. **View-only polish**: even with `view=1`, the spreadsheet's "+" (add sheet) and the slides'
   notes pane show. A view-only build (a smaller WASM without the editing features) would also cut
   the transfer. Request it after watching upstream for a while
3. **Browsers without `navigator.gpu`**: the boot page does not stop on WebGPU, so these should draw
   through WebGL2, but Firefox and older Safari are unconfirmed
4. **The ceiling's value, and memory outside the WASM**: the ceiling is set around 1 GiB by
   measurement during implementation. What ibisOffice hands to the browser's image decoder and GPU
   memory are not covered and fall to the crash marks (decision 3). If crashing documents become
   noticeable, look for another means
5. **Cost on opening, and devices**: reaching the original of a dataset whose first resource is an
   XLS costs a 16 MB transfer and hundreds of MB of memory. On smartphones (per-tab memory limits) or with
   data saving on (Save-Data), consider opening the original only when "Original" is pressed.
   Smartphones were not measured. If the first WASM transfer (16.4 MB gzipped) becomes a problem,
   precompress it (10.1 MB with brotli at quality 11; zstd too where CloudFront is not in front, as
   CloudFront does not handle zstd)
6. **Keeping up**: Dependabot cannot track it, so `manifest.json` (version and SHA-256), `LICENSE`,
   `NOTICE` and `SOURCE` are raised by hand. Upstream moves fast (0.8.4 two weeks after release), so
   script it. On each upgrade, check that the memory ceiling still takes, that it draws without
   `'unsafe-eval'`, and that the WebRTC names removed are still enough
7. **Remaining ways out**: a fully compromised WASM reaches most JS APIs through the generic bridge
   among its imports. WebRTC is removed, fetching it again from a child iframe is blocked in Chrome,
   and DNS prefetching is turned off (decision 2). Other browsers' behaviour and channels not yet
   known are accepted. If browsers come to close such channels themselves (CSP's `webrtc` directive
   or the like), add that too
8. **Language**: the boot page does not carry over upstream `index.html`'s language detection, so
   ibisOffice's own wording (the info bar and so on) may not follow KUKAN's display language. Decide
   how to pass the locale
9. **Link resources whose file was never stored**: `/preview` cannot return them, so `ibis-office`
   sites cannot show their original (Office Online Viewer took the outside URL directly)
10. **Going back to F**: adopting F means moving the conversion to an environment with neither
    secrets nor network (a dedicated container with `network_mode: none` in Compose, a separate
    service with no IAM role and outbound traffic denied on AWS). §F's measurements and §How
    spreadsheets are exported stay as the premises for that

## Related ADRs

- ADR-007 (Data Editor; editing belongs there), ADR-017 (`/preview`), ADR-051 (Ichitaro in the
  browser, the precedent for bundling)
- Referred to when weighing F: ADR-046 (interpretation artifacts), ADR-048 (table preview), ADR-057
  (XLSX as tables), ADR-059 (worker child process)
