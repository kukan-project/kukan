# ADR-019: ロギング戦略 — 構造化ログ + インフラ層収集

## ステータス

承認済み（2026-03-31）

## コンテキスト

KUKAN は AWS（ECS Fargate + ALB）とオンプレ（Docker Compose）のハイブリッドデプロイを想定している。
現状のロギングには以下の問題がある:

- **`console.log` のみ**: 構造化されておらず、ログレベル（info / warn / error）の区分がない
- **フォーマット不統一**: `[Worker] ...` 等の手動プレフィックスが一部にあるだけ
- **相関 ID なし**: リクエストやジョブを跨いだトレースができない
- **検索困難**: プレーンテキストのため、本番環境でのログ検索・フィルタリングが非効率

ADR-005 で「メトリクス / ロギングはアダプター不要、ロガー設定で十分」と決定済み。
この方針に沿い、**アプリ側にログアダプターは作らない**設計とする。

## 決定

### 原則: stdout 構造化 JSON + インフラ層で収集

アプリは **stdout に構造化 JSON を出力するだけ**とし、収集・保存・可視化はインフラ層に任せる。
アプリコードは AWS / オンプレで同一。環境ごとの差異はインフラ層で吸収する。

```
┌──────────────┐   stdout    ┌─────────────┐   push    ┌──────────┐
│  App (pino)  │ ─────────▶ │  Collector   │ ───────▶ │  Store   │
│  web/worker  │  JSON logs  │              │          │          │
└──────────────┘             └─────────────┘          └────┬─────┘
                                                           │ query
                                                      ┌────▼─────┐
                                                      │  Viewer  │
                                                      └──────────┘
```

| 環境     | Collector                    | Store           | Viewer                |
| -------- | ---------------------------- | --------------- | --------------------- |
| AWS      | ECS Fargate 標準（自動収集） | CloudWatch Logs | CloudWatch コンソール |
| オンプレ | Fluent Bit                   | Loki            | Grafana               |

### アプリ側: pino による構造化ログ

- **pino** を採用（Node.js 最速の JSON ロガー、Fastify / Hono エコシステムで実績）
- JSON 形式で stdout に出力（`level`, `time`, `msg`, `requestId` 等）
- ログレベル: `fatal` / `error` / `warn` / `info` / `debug` / `trace`
- 開発環境では `pino-pretty` で人間が読みやすい形式に変換

### AWS 環境: CloudWatch Logs

- ECS Fargate は stdout を自動的に CloudWatch Logs に送信（awslogs ドライバー）
- Worker は既に CDK で CloudWatch LogGroup を設定済み（`/kukan/worker`, 1ヶ月保持）
- Web（ECS Fargate）も同様に CloudWatch LogGroup で収集
- JSON 形式のため CloudWatch Logs Insights でフィールド検索可能

### オンプレ環境: Fluent Bit + Loki + Grafana

3つのコンポーネントを `compose.yml` に追加する:

#### Fluent Bit（ログ収集）

- C 言語製の軽量ログコレクター（メモリ ~30MB）
- Docker コンテナの stdout/stderr を収集し、ラベルを付与して Loki に送信
- Fluentd（Ruby 製）より軽量でコンテナ環境に適している

#### Loki（ログ保存・検索）

- Grafana 社のログ集約システム（メモリ ~200-500MB）
- **ラベルのみインデックス**するためストレージ・メモリ消費が小さい（Elasticsearch/OpenSearch 比で桁違い）
- LogQL でクエリ: `{app="worker"} |= "error" | json | level="error"`
- ストレージ: ローカルファイルシステム（S3 互換にも対応可能）

#### Grafana（可視化・UI）

- ブラウザベースのダッシュボード（メモリ ~100-200MB）
- ログ検索・フィルタリング・アラート設定
- CloudWatch Logs Insights に相当する機能をオンプレで提供

## ログフォーマット仕様

### 共通フィールド

すべてのログ行に含まれる pino 標準フィールド:

| フィールド | 型     | 説明                                |
| ---------- | ------ | ----------------------------------- |
| `level`    | number | ログレベル（10〜60、下表参照）      |
| `time`     | number | Unix epoch ミリ秒                   |
| `name`     | string | ロガー名（`api` / `worker`）        |
| `msg`      | string | ログメッセージ                      |
| `pid`      | number | プロセス ID                         |
| `hostname` | string | ホスト名                            |

**ログレベル値:**

| レベル  | 値 |
| ------- | -- |
| `trace` | 10 |
| `debug` | 20 |
| `info`  | 30 |
| `warn`  | 40 |
| `error` | 50 |
| `fatal` | 60 |

### コンテキスト別フィールド

pino の `child()` で付与されるスコープ付きフィールド:

| コンテキスト     | フィールド                               | 由来                                       |
| ---------------- | ---------------------------------------- | ------------------------------------------ |
| API リクエスト   | `requestId`                              | `hono/request-id` → `child({ requestId })` |
| リクエスト完了   | `method`, `path`, `status`, `elapsed`    | logger ミドルウェア                        |
| Worker ジョブ    | `jobId`, `resourceId`                    | ジョブ処理時に付与                         |
| SQS アダプター   | `component: "sqs"`                       | `child({ component: 'sqs' })`             |
| エラー           | `err` (`type`, `message`, `stack`)       | pino が自動シリアライズ                    |

### 出力例

**リクエスト完了（本番 JSON）:**

```json
{
  "level": 30,
  "time": 1712467200000,
  "name": "api",
  "requestId": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
  "method": "GET",
  "path": "/api/v1/packages",
  "status": 200,
  "elapsed": 42,
  "msg": "request completed"
}
```

**エラー（本番 JSON）:**

```json
{
  "level": 50,
  "time": 1712467200000,
  "name": "api",
  "requestId": "f47ac10b-...",
  "err": {
    "type": "Error",
    "message": "connection refused",
    "stack": "Error: connection refused\n    at ..."
  },
  "msg": "Unhandled error"
}
```

**Worker ジョブ処理:**

```json
{
  "level": 30,
  "time": 1712467200000,
  "name": "worker",
  "jobId": "msg-abc123",
  "resourceId": "res-456",
  "msg": "Processing resource"
}
```

**開発環境（pino-pretty）:**

```
14:23:45.123 INFO (api): request completed
    requestId: "f47ac10b-..."
    method: "GET"
    path: "/api/v1/packages"
    status: 200
    elapsed: 42
```

### CloudWatch Logs Insights クエリ例

```sql
-- エラーログ一覧
fields @timestamp, msg, err.message, requestId
| filter level >= 50
| sort @timestamp desc

-- 特定リクエストの追跡（requestId で相関）
fields @timestamp, msg, method, path, status, elapsed
| filter requestId = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
| sort @timestamp asc

-- 遅いリクエスト（500ms 超）
fields method, path, status, elapsed
| filter msg = "request completed" and elapsed > 500
| sort elapsed desc

-- Worker ジョブエラー
fields @timestamp, msg, jobId, resourceId, err.message
| filter name = "worker" and level >= 50
| sort @timestamp desc
```

### 環境変数

| 変数        | デフォルト | 説明                                                     |
| ----------- | ---------- | -------------------------------------------------------- |
| `LOG_LEVEL` | `info`     | ログレベル（`trace`/`debug`/`info`/`warn`/`error`/`fatal`） |

`createLogger()` の `level` オプションで明示指定した場合はそちらが優先される。

## 根拠

### pino を選ぶ理由

| ライブラリ | 速度   | JSON ネイティブ | エコシステム        |
| ---------- | ------ | --------------- | ------------------- |
| pino       | 最速   | ✅              | Hono / Fastify 実績 |
| winston    | 遅い   | プラグイン      | Express 時代の定番  |
| bunyan     | 中程度 | ✅              | メンテ停滞          |
| console    | N/A    | ❌              | 本番運用に不十分    |

### Loki + Fluent Bit を選ぶ理由（vs ELK）

| 観点                | ELK (Elasticsearch + Logstash + Kibana) | Loki + Fluent Bit + Grafana                |
| ------------------- | --------------------------------------- | ------------------------------------------ |
| メモリ消費          | 数 GB                                   | ~500MB 合計                                |
| ディスク消費        | 大（全文インデックス）                  | 小（ラベルのみインデックス）               |
| セットアップ        | 複雑                                    | Docker Compose で簡単                      |
| 閉域網適性          | 重すぎる                                | 軽量で適している                           |
| OpenSearch との競合 | 検索エンジンとログ基盤の役割混在        | 役割分離（検索は OpenSearch、ログは Loki） |

KUKAN は既に OpenSearch を検索エンジンとして使用しているため、
ログ基盤にも OpenSearch を使うと役割が混在し運用が複雑になる。Loki で分離する。

### アダプターを作らない理由

ADR-005 の方針に沿い、アプリコードにログアダプターは不要:

- アプリは stdout に JSON を出すだけ（pino の設定のみ）
- 収集はインフラ層が担当（CloudWatch / Fluent Bit）
- AWS でもオンプレでもアプリコードは同一

## 影響

### リソース消費（オンプレ追加分）

| コンポーネント | メモリ     | ディスク                   |
| -------------- | ---------- | -------------------------- |
| Fluent Bit     | ~30MB      | ほぼなし                   |
| Loki           | ~200-500MB | ログ量に比例（圧縮率高い） |
| Grafana        | ~100-200MB | ~数百MB                    |

### 実装範囲

- **pino 導入**: `packages/api` と `apps/worker` に pino を追加、既存 `console.log` を置換
- **compose.yml**: Fluent Bit / Loki / Grafana の3サービスを追加（profile で分離可能）
- **CDK**: Web（ECS Fargate）の CloudWatch Logs 設定を明示化

実装済み。ロガーファクトリは `packages/shared/src/logger.ts`、ESLint `no-console` ルールで今後の `console.*` 混入を防止。

## 関連

- ADR-005: アダプターは4つだけ — メトリクス/ロギングはアダプター不要と決定
- ADR-020: Web = ECS Fargate + ALB, Worker = ECS Fargate — CloudWatch Logs の収集元
- CDK Worker ログ設定: `infra/lib/constructs/worker-service.ts`
- 既存ロガーミドルウェア: `packages/api/src/middleware/logger.ts`
