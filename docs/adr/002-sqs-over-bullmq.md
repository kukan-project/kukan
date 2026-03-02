# ADR-002: SQS + InProcess を採用し、Redis/BullMQ を排除する

## ステータス

承認済み（2026-03-01）

## コンテキスト

Ingestパイプラインのジョブキューイング方式を決める必要がある。
v3設計ではRedis + BullMQを全環境で使う方針だったが、
自治体ポータルの処理量（日に数回〜数十回）に対してRedisは過剰と判断。

## 検討した選択肢

### A) Redis + BullMQ（全環境共通）— v3の設計

- 良い点: 成熟したライブラリ、優先度キュー、ジョブチェーン、リトライ機能
- 問題点:
  - 開発環境でもRedis必須（docker-compose追加）
  - オンプレ閉域網でRedisが追加の運用負担
  - AWS環境ではElastiCache（~$13/月〜）が必要
  - 自治体ポータルの処理量に対してインフラコストが見合わない

### B) SQS（AWS）+ InProcess（開発・オンプレ）— 採用

- 良い点:
  - AWS: SQS月100万リクエスト無料、DLQ標準、14日メッセージ保持
  - 開発/オンプレ: Redis不要、プロセス内で直接処理
  - QueueAdapterで抽象化し環境差を吸収
  - API/Worker分離が自然（SQSイベント駆動）
- 問題点:
  - InProcessはプロセス再起動でジョブ消失（小規模なら許容可）
  - SQSはFIFO保証にやや制約（標準キューで十分）

### C) BullMQ — 将来オプション

- QueueAdapterの3番目の実装として残す
- 大規模オンプレ環境（日に数百件以上の処理）のみ

## 決定

選択肢Bを採用。選択肢Cは将来オプションとして残す。

## 根拠

- 自治体ポータルの典型的な処理量では、SQS無料枠で永久に$0
- Redis排除でインフラ構成要素が1つ減り、全環境で運用が簡素化
- API(0.25vCPU)とWorker(1vCPU)のスケール特性が異なるため、SQSによるイベント駆動分離が自然
- 月額コスト ~$38削減（ElastiCache不要）

## 影響

- ElastiCache完全削除 → 中規模AWS構成で月額 ~$122（旧$160、24%削減）
- Docker Compose構成からRedisコンテナ削除
- デプロイプロファイルからcacheプロパティ削除、lru-cacheユーティリティに統一
- QueueAdapter: SqsQueueAdapter / InProcessQueueAdapter / (将来)BullMQQueueAdapter
