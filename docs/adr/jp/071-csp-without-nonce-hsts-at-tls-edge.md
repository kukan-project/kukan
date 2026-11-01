# ADR-071: CSP を nonce なしで入れ、HSTS を TLS 終端で出す

## ステータス

**採用（Accepted）** — 2026-11-01

すべてのページに Content-Security-Policy を出す。`script-src` は `'unsafe-inline'` を含み、nonce も
ハッシュも使わない。ポリシーは `CSP_MODE`（既定 `report-only`）で報告だけの状態から入れ、
違反が無いことを確かめてから `enforce` に切り替える。Office プレビューの `frame-src`（ADR-065）は
report-only の間も強制のまま変えない。違反の報告先は置かない。HSTS は TLS を終端するもの —
AWS では CloudFront、Docker Compose では Caddy の TLS サイトブロック — だけが出す。`max-age` は 1 年、
`includeSubDomains` は既定で付けずサイト単位で選び、`preload` は付けない。

## コンテキスト

### 1. 無かったもの

セキュリティ監査で、AWS と Docker Compose のどちらの構成にも Content-Security-Policy と
Strict-Transport-Security が無いことが分かった。同じ時期に保存型 XSS が 1 件見つかり、修正した。
CSP が入っていれば、その XSS で読み込めるスクリプトと、盗んだものを送れる先は縛られていた。
HSTS は、HTTPS で公開しているサイトで、最初の HTTP 接続を狙う中間者を閉じる。

今あるのは、`apps/web/src/proxy.ts` が要求ごとに付ける `Content-Security-Policy: frame-src …`
（ADR-065 決定 2。Office プレビューの sandbox の iframe を外へ逃がさない）と、`next.config.ts` の
4 つのヘッダー（`X-Frame-Options: SAMEORIGIN`、`X-Content-Type-Options: nosniff`、`Referrer-Policy`、
`Permissions-Policy`）である。

### 2. インラインスクリプトの制約

Next.js の App Router は、RSC のペイロードとハイドレーションのためのインラインスクリプトを HTML に
埋め込む。内容は描画ごとに変わるので、ハッシュで許可できない。Next.js が案内する方法は nonce で、
要求ごとに nonce を作り、ページを動的に描画する。

KUKAN の公開ページは CloudFront の HTML キャッシュで配る（ADR-027）。同じ HTML を 60〜300 秒、
すべての閲覧者に返す。nonce はヘッダーと HTML に同じ値が要り、要求ごとに違わなければ意味が無い。
キャッシュした HTML に nonce を入れれば、全員が同じ nonce を持つ — 無いのと同じである。
nonce を使うには HTML キャッシュを捨てなければならない。

### 3. ページが読みに行くもの

- ブランドが `gaMeasurementId` を持つとき、gtag.js を `www.googletagmanager.com` から読み、計測は
  `*.google-analytics.com` / `*.analytics.google.com` / `*.googletagmanager.com` へ送る（ADR-024）
- GeoJSON の地図は OpenStreetMap と国土地理院のタイルを `<img>` で読む
- 組織とグループは、編集者が入力した URL の画像を表示する。ブランドのロゴも自分のホストに置ける
- ファイルのアップロードは、API が返す署名付き URL へブラウザが直接 PUT する（`use-file-upload.ts`）。
  その先は MinIO か S3 で、サイトのオリジンではない
- Web Worker は 3 つ（DuckDB-WASM、Office パッケージの検査、一太郎の描画）で、どれも同一オリジンの
  `_next/static` から読む
- フォームの送信はすべて fetch で、HTML のフォーム送信はない。サインインはメールとパスワードで、
  IdP へのリダイレクトはない
- `next dev` は Fast Refresh のために `eval` を使う。本番のビルドは使わない

### 4. HSTS を出せる場所

HSTS を出してよいのは TLS を終端するものだけである。AWS では CloudFront（オリジンは HTTP）、
Compose では Caddy。Caddy の既定は `:80` の平文 HTTP で、LGWAN などの閉域網では HTTPS を使わずに
運用するサイトがある。

## 検討した選択肢

### A) nonce と `'strict-dynamic'` — 不採用

インラインの注入を止められる、最も強い形である。しかし §2 のとおり HTML キャッシュと両立しない。
キャッシュを捨てれば、公開ページの応答がすべてオリジンに届き、ADR-027 で得た体感速度と
耐負荷を失う。

### B) ハッシュ — 不採用

インラインスクリプトの内容が描画ごとに変わるので、ハッシュを事前に列挙できない。

### C) `'unsafe-inline'` を含むポリシー — 採用

インラインスクリプトの注入は止まらない。それでも、外部スクリプトの読み込み先、データの送信先
（`connect-src`）、frame、`<object>`、`<base>`、フォームの送信先、埋め込まれる側（`frame-ancestors`）
は縛れる。XSS で読み込める道具と、持ち出しの道を狭めるのがこの CSP の価値であり、注入そのものを
止めるものではない。

### D) 最初から enforce — 不採用

ページが読むものの一覧（§3）はコードを読んで作ったもので、ブランドや環境ごとの違いを全部は
拾えていないかもしれない。止めてから気づくより、報告だけで入れて確かめる。

### E) `CSP_MODE` で report-only から入れる — 採用

`Content-Security-Policy-Report-Only` は何も止めず、違反はブラウザのコンソールに出る。
`securitypolicyviolation` イベントも発火するので、E2E テストで拾える。

### F) 違反の報告先（`report-to` / `report-uri`） — 不採用

報告先は未認証の誰でも書き込める口になる。偽の報告を送り込める、容量を食う、拡張機能の
ノイズが多い。検証は DevTools と E2E テストで足りる。

### G) HSTS の `preload` — 不採用

preload リストに入ると、外すのに数か月かかる。ドメインを手放す、HTTPS をやめる、といった変更が
戻せなくなる。`includeSubDomains` も同じ理由で既定では付けない — ドメイン配下のすべてのホストを
HTTPS に縛るのは、カタログでなく運用者の判断である。

## 決定

### 1. ポリシー

`apps/web/src/lib/csp.ts` の `buildContentSecurityPolicy` が組む。既定のブランド（GA4 なし、本番）では
次のとおり。`<origin>` はサイトの設定上のオリジンと要求のオリジン（proxy.ts が今も計算している）。

```
default-src 'self';
script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval';
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https: http:;
font-src 'self' data:;
connect-src 'self';
worker-src 'self';
frame-src <origin>/vendor/ibis-office/boot.html <origin>/api/v1/resources/;
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'self'
```

- `connect-src` にはアップロード先のオリジンを足す。`S3_ENDPOINT` があればそのオリジン（MinIO、または
  名前で届く S3）、無ければ SDK が署名するバケットの仮想ホスト形式のアドレス
  `https://<S3_BUCKET>.s3.<S3_REGION>.amazonaws.com`（バケット名にドットがあれば SDK がパス形式で署名するので
  `https://s3.<S3_REGION>.amazonaws.com`。`uploadOrigin`）
- GA4 のあるブランドでは `script-src` に `https://www.googletagmanager.com`、`connect-src` に
  `https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com` を足す
- 開発（`NODE_ENV=development`）では `script-src` に `'unsafe-eval'` を足す。Fast Refresh が要る
- `img-src` はどのホストも許す。組織とグループの画像は編集者が入力した URL で、ブランドのロゴも
  外のホストに置ける。この結果、`<img>` による持ち出しは防げない。`connect-src 'self'` が fetch と
  XHR と WebSocket と beacon の送信先を縛るので、持ち出しの主な道は閉じる。地図タイルと GA4 の
  計測画像もこれで通る
- `worker-src 'self'`。3 つの Worker は同一オリジンから読む。`blob:` は要らない
- `form-action 'self'`。フォームの送信はすべて fetch で、サインインもメールとパスワード。
  IdP へリダイレクトする OIDC を入れるときは見直す — HTML のフォーム送信への応答がリダイレクトなら、
  Chrome はそのリダイレクト先にも `form-action` を適用する
- `frame-ancestors 'self'` は `X-Frame-Options: SAMEORIGIN` と同じ意味。両方出す
- `frame-src` は ADR-065 決定 2 のまま。`office-online` のサイトでは Microsoft のビューアを足す
- `manifest-src` は置かない（マニフェストが無い）

### 2. 出し方 — `CSP_MODE`

環境変数 `CSP_MODE`（`report-only` / `enforce`、既定 `report-only`）。`OFFICE_PREVIEW_VIEWER` と同じく
web が要求ごとに読むので、切り替えにイメージのビルドは要らない。AWS ではサイトの `cspMode`、
Compose では `.env`（マルチサイトは `sites/<site>.env`）。

| `CSP_MODE`    | `Content-Security-Policy`          | `Content-Security-Policy-Report-Only` |
| ------------- | ---------------------------------- | ------------------------------------- |
| `report-only` | `frame-src …`（今までのまま）      | ポリシー全文                          |
| `enforce`     | ポリシー全文（`frame-src` を含む） | なし                                  |

report-only の間も `frame-src` の強制は弱めない。Office プレビューの sandbox を外へ逃がさないのは
ADR-065 の決定で、この ADR の段階的な導入とは別の話である。ibisOffice の起動ページは自分の
ポリシー（`sandbox allow-scripts; default-src 'none' …`）を持ち、`CSP_MODE` に関わらず変わらない。

### 3. 報告先は置かない

`report-to` も `report-uri` も付けない（選択肢 F）。確認は、ブラウザの DevTools のコンソールと、
主要なページを開いて `securitypolicyviolation` が発火しないことを確かめる E2E テスト
（`apps/web/src/__tests__/e2e/csp.e2e.ts`）で行う。report-only でもイベントは発火する。

### 4. ブランドの拡張

`BrandConfig` に `csp?: Partial<Record<string, string[]>>`（ディレクティブ → 追加するソース）を置く。
自分のホストから JS や CSS を読むブランド、別のドメインの API を呼ぶブランドが使う。
既定のブランドは何も足さない。足すだけで、外すことはできない。

### 5. HSTS

- **AWS**: CloudFront の ResponseHeadersPolicy（`kukan-<env>[-<site>]-security-headers`）で
  `Strict-Transport-Security: max-age=31536000` を出す。`includeSubDomains` はサイトの
  `hstsIncludeSubDomains`（既定 `false`）、`preload` は常に無し、オリジンの値は上書きする。
  すべてのビヘイビア（ページ、`/_next/static`、`/api`、`/auth`、`/odata`、sitemap と robots.txt）に
  付ける。最初に見るのがどのパスでも効くように
- `next.config.ts` の 4 つのヘッダーは CloudFront に写さない。オリジンが自分の作るすべての応答に
  付けており、2 か所に置けば食い違う場所が 1 つ増える。オリジンが作らない応答（ALB のエラー）
  には守るべき HTML が無い。HSTS だけが CloudFront の役目である — 閲覧者が HTTPS で来たことを
  知っているのは TLS 終端だけで、オリジンは知らない
- **Compose**: `docker/Caddyfile` に `(hsts)` スニペットを例として置き、TLS のサイトブロックから
  `import hsts` する。既定の `:80` ブロックには付けず、その挙動も変えない

### 6. 閉域網への注記

ブラウザは、平文 HTTP で受けた `Strict-Transport-Security` を無視する（RFC 6797 §8.1）。
HTTP だけで公開している非公開ドメインのサイトは、この ADR で何も変わらない。

危険があるのは 1 つで、親ドメイン（たとえば `example.lg.jp`）が `includeSubDomains` 付きの HSTS を
出しているとき、その配下の HTTP だけのサイト（`catalog.example.lg.jp`）はブラウザに HTTPS を
強いられ、開けなくなる。これは KUKAN の外で起きることで、KUKAN は防げない。運用者への注意として
管理者ガイドに書く。

## 影響

- 公開ページの応答に `Content-Security-Policy-Report-Only` が加わる。何も止めず、違反はブラウザの
  コンソールに出る
- AWS では CloudFront の配信に ResponseHeadersPolicy が 1 つ加わり、すべての応答に
  `Strict-Transport-Security` が付く。CloudFront はすでに HTTP を HTTPS にリダイレクトしているので、
  閲覧者に見える変化は無い
- `enforce` にしたサイトで、ブランドが外部の JS や CSS を読んでいれば止まる。`csp` で足す
- ブランドの `csp` は、守りを緩める方向にしか使えない。ブランドの変更はレビューで見る
- `pnpm test:e2e` に csp.e2e.ts が加わる。開発サーバー（`'unsafe-eval'` あり）で走る

## 残課題

1. **既定を `enforce` に切り替える。** demo で report-only のまま運用し、違反が無いことを確かめた
   あとのリリースで既定を変える。破壊的変更としてリリースノートに書き、report-only に留めたい
   サイトは `CSP_MODE=report-only` を明示する。既定は `@kukan/shared` の `DEFAULT_CSP_MODE`
   1 箇所にあり、web の既定値も infra の「既定と違うときだけ環境変数を出す」判定もそれを読む
2. **`'unsafe-inline'` を外す。** Next.js がインラインスクリプトをハッシュで許可できる形にするか、
   HTML キャッシュと両立する nonce の配り方（エッジでの差し込み）ができたら、見直す
3. **`img-src` を狭める。** 組織・グループの画像をアップロードに変える、または許すホストを
   サイトの設定にすれば `https:` を外せる。今は編集者の入力 URL のまま
4. **OIDC を入れるときの `form-action`。** §決定 1 のとおり

## 関連

- ADR-023 / ADR-042: ブランドオーバーライド・マルチブランドビルド（`csp` の置き場）
- ADR-024: GA4 アクセス統計（gtag.js のホスト）
- ADR-027: CloudFront 再導入（HTML キャッシュ — nonce を採らない理由）
- ADR-041: マルチサイトデプロイ（サイトごとの `cspMode` / `hstsIncludeSubDomains`）
- ADR-065: Office 文書の原本をブラウザに描く（`frame-src` と起動ページのポリシー）
- ADR-070: 製品名は名乗りバージョンは未認証に出さない（同じ `OFFICE_PREVIEW_VIEWER` 型の設定の配り方）
