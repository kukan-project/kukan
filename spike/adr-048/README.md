# ADR-048 スパイク: DuckDB-WASM の Range 読み登録

ADR-048（テーブルプレビューの一枚化）の承認前提となる実測ハーネス。
判定と実測値は `docs/adr/jp/048-modeless-table-preview.md` の「実測結果」節が正本。

## 実行方法

```bash
# 1. 合成 Parquet を生成（rg5000 / rg100k の 2 変種、既定 600 万行 ≈ 400 MB）
node spike/adr-048/generate-parquet.mjs

# 2. duckdb-wasm を apache-arrow 込みで ESM バンドル（bare import 解決のため）
node_modules/.bin/esbuild \
  node_modules/.pnpm/@duckdb+duckdb-wasm@1.33.1-dev57.0/node_modules/@duckdb/duckdb-wasm/dist/duckdb-browser.mjs \
  --bundle --format=esm --outfile=spike/adr-048/vendor/duckdb-bundle.mjs

# 3. 計測（ideal + proxy × 2 変種 × default/range 構成）
node spike/adr-048/run.mjs            # フル
node spike/adr-048/run.mjs --quick    # ideal モードのみ
node spike/adr-048/run.mjs --quick --file rg5000.parquet
```

結果は標準出力と `results.json`（gitignore 済み）に出る。

## 構成

- `generate-parquet.mjs` — Interpret と同条件（zstd、`ROW_GROUP_SIZE`）の合成 Parquet 生成
- `server.mjs` — Range サーバー。`ideal`（RFC 準拠）と `proxy`
  （**修正前の** `/api/v1/resources/:id/preview` の忠実エミュレーション: 終端なし
  Range の 1 MB 切り詰め、suffix 形式 416、HEAD に Content-Length なし。修正の
  根拠となった歴史的証拠として保持）の 2 人格
- `page.html` — DuckDB-WASM を起動しクエリを実行する計測ページ
- `run.mjs` — Playwright ドライバ。シナリオごとにリクエスト数・転送バイト・
  所要時間・Chromium RSS を記録
- `two-phase-check.mjs` — 2 フェーズ読みの後段（`file_row_number IN` による
  表示行取得）の転送量計測。ソート済みページの表示行は散在するため 1 ページ
  50 MB 級が下限 — 決定 4（現行上限では全量バッファ維持）の根拠。結果 JSON は
  出力するがコミットしない（数値の正本は ADR）
- `head-semantics-check.mjs` — HEAD が Range を無視する（RFC 9110 §14.2、修正後の
  実装）場合でも Range モードが活性化することの再現確認。サイズ調査は
  `GET bytes=0-0` → HEAD の Content-Length（status 不問）で成立する

## 要点（詳細は ADR 本文）

- Range モードの活性化には `db.open()` の filesystem フラグ **と**
  `registerFileURL(..., directIO: true)` の両方が必要（既定は常に全量ダウンロード）
- `SELECT *` の Top-N ソートは遅延実体化が効かずほぼ全量転送。ソート列のみ投影する
  2 フェーズ読みなら基準内
- 現行 `/preview` エミュレーションでは終端なし Range の 1 MB 切り詰めにより
  ファイルサイズが誤認され Range モードは全滅（サーバー修正が必須）
