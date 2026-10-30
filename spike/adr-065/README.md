# Office 文書の原本をブラウザで描く — 試作ハーネス

Office 文書（DOCX・XLSX・PPTX・DOC・XLS・PPT）の原本プレビューを Office Online Viewer に
頼らず出す方式を比べるための計測ハーネス。判定と実測値は ADR-065
（`docs/adr/jp/065-office-original-preview.md`）の「実測」節が正本で、ここには再現手段だけを置く。

比べたもの:

- **ibisOffice（I、採用）**: Rust を WebAssembly にしたオフィススイート。WebGPU、使えなければ WebGL2 で描く
- **軽いライブラリ（C）**: DOCX は docx-preview、PPTX は @aiden0z/pptx-renderer（どちらもブラウザ内で HTML/SVG に描く）
- **ZetaOffice（B）**: LibreOffice の WebAssembly ビルドを公開 CDN から読み、Qt のキャンバスに描く
- **LibreOffice（ネイティブ、F）**: node:24-alpine に apk で入れた LibreOffice を headless で動かし PDF にする

## サンプル

e-Gov データポータルの CKAN API（`resource_search?query=format:<FMT>`）で形式ごとに拾った
公開ファイル（PDL1.0 / CC BY）。手元の案件ファイルは使わない。PPT は同ポータルに小さな
ものが無いので、拾った PPTX 6 件を LibreOffice で PPT に保存したもの（PowerPoint 製でない点に注意）。
取得スクリプトはリポジトリに入れていない（`egov-fetch.mjs`、形式ごとに N 件・データセット重複なし・15 MB 未満）。

`data/samples/` に置く（ファイルごとに取得元の URL を書いた `<name>.txt` を添える）。F の PDF を
並べて見るときは `data/lo-pdf/<name>.pdf` に置く。`data/` はコミットしない。

## ibisOffice（I）

### 準備

```bash
cd spike/adr-065
npm install                              # playwright ほか（package-lock.json で固定）
# ibisOffice の Web 版（playground の app/）を vendor/ に取る。gh-pages は版ごとに上書き
# されるので、計測したコミット（0.8.4 の公開）を指して取る
git init -q vendor/ibis-office
git -C vendor/ibis-office remote add origin https://github.com/ibisjp/ibis-office.git
git -C vendor/ibis-office sparse-checkout set app
git -C vendor/ibis-office fetch -q --depth 1 --filter=blob:none origin f48b9b428fa51b6837e58638e73fd77a4514a722
git -C vendor/ibis-office checkout -q FETCH_HEAD
node ibis-server.mjs 8766 &
```

ADR-065 の数値（取り込む JS の関数の数などを含む）は、このコミット `f48b9b428fa5` の `app/` で
測った（計測時に取ったのは直後の `51eb7d20f768` だが、違いは `.nojekyll` の追加だけで `app/` は
同じ）。別の版を試すときは、コミットを替えて測り直す。

`ibis-server.mjs` は KUKAN が配るときと同じく、`app/` を gzip と 1 年の `Cache-Control` で配り、
文書を同じオリジンから渡す。`index.html` には計測用の `ibis-probe.js` を差し込む（アプリの
動きは変えない）。`/ibis-csp/` の下は厳しい CSP（`connect-src 'self'` など）付きで同じものを配る。

### 手で触る

`http://localhost:8766/` がギャラリー（`ibis.html`）。左でサンプルを選ぶと、上の帯に起動・
描き終わり・WASM メモリ・fps・描画の種類（WebGPU / WebGL2）・外部への通信が出る。
「LibreOffice の PDF と並べる」で F と見比べられる。

### 隔離した iframe で試す

`http://localhost:8766/sandbox-host.html?open=<サンプルのファイル名>` は、ADR-065 の決定 2 の形
（`sandbox="allow-scripts"` の iframe に、親が文書のバイト列を `postMessage` で渡す）で開く。
起動ページは `sandbox-boot.html` と `sandbox-boot.js`。iframe の中から Cookie・localStorage・
親の DOM・同じサーバー・外部に届くかを調べ、親の `window.__sandbox` に残す。

`sandbox-host.html` は `frame-src` を起動ページのパスに絞った CSP 付きで返す（`&frameSrc=0` で外す）。
`&leak=<URL>` を付けると、描いたあと iframe が自分をその URL へ遷移させ、文書の先頭のバイト列を
URL に載せて送ろうとする。外部役のサーバーを別のポートに立てて、`frame-src` が無いと届き、
有ると止まることを確かめられる。

同じサーバーへの取得は、iframe の JS からは失敗に見えてもリクエストは届く（CORS は応答を
読ませないだけ）。`/whoami` に届いたリクエストとその Cookie はサーバーが記録し、
`/whoami-log` で読める。`&cookie=none` で親のページの Cookie を SameSite=None に（既定は Lax）。起動ページの CSP は
ADR-065 の決定 2 と同じく、`script-src`・`img-src`・`font-src` を起動ページと配布物のパスに、
`connect-src` を配布物のパスに絞ったものが既定で、`&connect=self` のときだけ `connect-src` を
`'self'` に広げる（Cookie 付きで届くことを見せるため）。起動ページは、許していない同じ
オリジンのスクリプト（`/sandbox-forbidden.js`）を読もうとし、止まったかを記録する。

起動ページは iframe の中で `eval`・`new Function` が動くか（CSP で EvalError になるはず）と、
`RTCPeerConnection` が消えているかを `window.__sandbox.isolation` に残す。ADR-065 の決定 2 の
とおり、起動ページは WebRTC の関係のものを消してから `import()` で ibisOffice を読む。
確かめのための動き（`&rtc=` と `&connect=self`）は、安全な起動ページ（`/ibis-sandbox/boot.html`、
クエリを見ない）ではなく、別のパスの確かめ用ページ（`/ibis-sandbox-probe/boot.html`）が受け持つ。
親のページはそのときだけ確かめ用ページを `frame-src` に許し、ふだんは起動ページのパスだけを
許す（iframe の中のコードが確かめ用ページへ遷移できないように）。親は文書を 1 回だけ渡す。
`&rtc=turn:127.0.0.1:3478?transport=udp` を付けると、起動ページが ibisOffice を読む前（WebRTC
を消す前）に、自分のコードから TURN 役へ問い合わせる（UDP の受け口を別に立てて、sandbox の
iframe からも WebRTC で外へ出られることを確かめる）。参照は残さないので、ibisOffice からは
届かない。起動ページのメッセージの受け口は、スクリプトが自分で送った偽のメッセージ
（`isTrusted` でないもの）を捨てる。

起動ページは、WASM のメモリの宣言に最大値（既定 1 GiB）を書き足してから組み立てる（ADR-065 の
決定 3）。確かめ用ページでは `&memMax=<ページ数>`（1 ページ 64 KiB）で上限を変えられる。
WebRTC を消したあと、子 iframe から取り出し直せるかも `window.__sandbox.isolation.rtcInChildFrame`
に残す。起動ページと確かめ用ページの応答には `X-DNS-Prefetch-Control: off` を付ける（確かめ用ページは
`&dnsPrefetch=on` で外せる）。`&dns=<名前>` を付けると、確かめ用ページがあとから
`<link rel="dns-prefetch">` を足す。Chromium を `--log-net-log=<ファイル>` で起動し、その名前の
解決が記録に出るかで確かめる（Chromium 151 では、ヘッダーの有無に関わらず、ふつうのページでも
出なかった）。`LOG_WASM=1 node ibis-server.mjs` で WASM への要求を記録すると、隔離した iframe からの
取得がキャッシュされないことを確かめられる。ADR では WASM を親が取って渡すが、このハーネスでは
まだ iframe が取っている。

### 計測

```bash
# WSL の Chromium（画面付き）。WebGPU はソフトウェア（SwiftShader）
CHROME=~/.cache/ms-playwright/chromium-<rev>/chrome-linux64/chrome node run-ibis.mjs --out results

# Windows の Chrome（実 GPU）。WSL を mirrored ネットワークにして、Windows 側で起動しておく:
#   chrome.exe --remote-debugging-port=9333 --user-data-dir=C:\...\Temp\ibis-spike-profile
# GPU 無しの代わりは、同じく --disable-gpu を足して別のポート・プロファイルで起動する
CDP=http://127.0.0.1:9333 CDP_PROFILE='C:\...\Temp\ibis-spike-profile' \
  node run-ibis.mjs --out results/win
```

1 件ごとに、起動・描き終わりの時間、WASM メモリ、プロセスのメモリ（Linux は `ps`、Windows は
PowerShell で読み込み後に 1 回）、ホイール 30 回の間のフレーム間隔、画面写真を記録する。
最初の 1 件の前にキャッシュを消すので、1 件目がコールド起動になる。`--csp` で `/ibis-csp/`
を、`--only xls,xlsx` で形式を絞る。結果は `results-ibis.json` で、`results/` はコミットしない。

## 軽いライブラリ（C）・ZetaOffice（B）

```bash
SAMPLES=data/samples node server.mjs 8765 &
node run.mjs light --out ./results       # DOCX・PPTX を軽いライブラリで描く
node run.mjs frame --out ./results       # ZetaOffice がクロスオリジン分離なしで動くか
node run.mjs zeta  --out ./results       # ZetaOffice で全形式（CDN から読む。コールド／ウォーム起動も記録）
```

`server.mjs` は `/iso/` 配下のパスにだけ COOP / COEP を付ける。同じページを `/iso/` あり・なしで
開き比べられる。結果は `results-<mode>.json` と画面写真（`<mode>-<index>.png`）。

## LibreOffice ネイティブ（F）

Docker コンテナで行った（`node:24-alpine` に
`apk add libreoffice-writer libreoffice-calc libreoffice-impress font-noto-cjk poppler-utils`、
1 ファイル 1 プロセスで `soffice --headless --convert-to pdf`、`/proc/<pid>/status` の VmHWM を
0.1 秒ごとに読んで最大値を記録）。手順は ADR に書いた。

## 構成

- `ibis-server.mjs` — ibisOffice 用の静的サーバー。`/manifest.json`、`/files/<name>`（文書）、`/lo/<name>.pdf`（F の PDF）、`/ibis/`・`/ibis-csp/`（アプリ）
- `ibis-probe.js` — ibisOffice のページ内で時間・フレーム・メモリ・長いタスク・外部通信・エラーを `window.__ibis` に残す
- `ibis.html` — 手で触るためのギャラリー
- `sandbox-host.html`・`sandbox-boot.html`・`sandbox-boot.js` — 隔離した iframe で起動する形の試作
- `run-ibis.mjs` — ibisOffice の Playwright ドライバ（WSL の Chromium、または CDP で Windows の Chrome）
- `server.mjs` — C・B 用の静的サーバー。`/manifest.json`、`/sample/<i>`、`/iso/` で分離ヘッダー
- `page-light.html` — docx-preview / pptx-renderer で 1 件描き、`window.__result` に結果を残す
- `page-zeta.html` + `zeta-thread.js` — ZetaOffice を起動し、`window.__open(i)` で順に開く（読み取り専用、マクロ無効）
- `run.mjs` — C・B の Playwright ドライバ。所要時間・JS ヒープ・WASM メモリ・CDN 転送量・画面写真を記録
