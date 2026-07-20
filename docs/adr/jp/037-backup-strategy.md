# ADR-037: スケール連動バックアップ戦略（S3 バージョニング + AWS Backup + DB 保持期間）

## ステータス

**承認済み（Accepted）**

## コンテキスト

アップロードファイルの保全性と可用性は、データカタログの導入判断で必ず問われる
観点である（特に行政・公共分野では文書管理規程への適合が前提になる）。
一方、現状の AWS デプロイのデータ保護には次のギャップがある。

- **S3**: 耐久性はイレブンナイン（リージョン内 3+ AZ 複製）だが、
  **バージョニングが無効**のため、アプリ経由・人為的な削除や上書きからは
  復旧できない。インフラ障害には強く、操作ミスには無防備という非対称がある
- **RDS/Aurora**: 自動バックアップは有効だが保持期間が **CDK デフォルトの1日**。
  ポイントインタイムリカバリ（PITR）の窓が1日では、気づくのが遅れた
  データ破損に対応できない
- **隔離バックアップなし**: すべてのバックアップが元リソースに紐づいており、
  DB インスタンスごと削除される事故や、アカウント内の広範な誤操作・不正操作に
  対して独立した復元手段がない

また、RDS/Aurora の自動バックアップは仕様上 **35日が保持上限**であり、
行政の文書管理規程で求められうる長期世代（月次×年単位）はネイティブ機能だけでは
実現できない。

## 決定

### 2層のバックアップ構成

守る脅威が異なる2層を併用する。

| 層                                     | 実体                                 | 担当                                                           |
| -------------------------------------- | ------------------------------------ | -------------------------------------------------------------- |
| ネイティブ（S3 バージョニング / PITR） | 連続的・リソースに紐づく             | 直近の誤削除・データ破損からの即時復旧（秒〜オブジェクト単位） |
| AWS Backup（Backup Vault + Plan）      | 日次・月次スナップショットを隔離保管 | リソースごと消える事故、35日超の長期世代、隔離保全             |

直近期間は両層に重複して存在するが、「すぐ戻せる連続バックアップ」と
「隔離された退避コピー」で目的が異なるため、重複は許容する（定石構成）。

### `ScaleComputed` に `backup` セクションを追加

バックアップ設定は独立フィールドではなく **scale プリセットの一部**とする
（ADR-031 の「preset + deep-partial `overrides`」機構に乗せる）。
`db.multiAz` / `opensearch.indexReplicas` と同様、「可用性・保全ポリシーは
scale が規定し、env 個別の事情は `overrides` で微調整する」前例に従う。

```ts
backup: {
  /** S3 バージョニング（誤削除・上書き保護。AWS Backup の S3 対象化にも必須） */
  s3Versioning: boolean
  /** 旧バージョンの保持日数（バージョニングの保管コスト抑制） */
  s3NoncurrentVersionExpirationDays: number
  /** RDS/Aurora 自動バックアップ保持日数 = PITR 窓（1〜35） */
  dbBackupRetentionDays: number
  /** AWS Backup プラン。false = 無効 */
  awsBackup: false | { dailyRetentionDays: number; monthlyRetentionMonths: number }
}
```

### scale 別デフォルト

| 設定                                | small | medium | large                 |
| ----------------------------------- | :---: | :----: | :-------------------- |
| `s3Versioning`                      | false |  true  | true                  |
| `s3NoncurrentVersionExpirationDays` |   —   |   30   | 30                    |
| `dbBackupRetentionDays`             |   7   |   14   | 35                    |
| `awsBackup`                         | false | false  | 日次35日 + 月次12ヶ月 |

- small も CDK デフォルト（1日）から **7日**へ引き上げる。開発環境でも
  PITR 窓1日は復旧手段として心もとなく、追加コストはわずか
- large は「可用性・保全重視の本番」を表現する。月次世代数は導入組織の
  文書管理規程に応じて `overrides` で調整する

### 矛盾構成は synth 時エラーにする

AWS Backup の S3 バックアップは**バージョニング有効が前提**（AWS 側の制約）。
`awsBackup` 有効かつ `s3Versioning: false` の組み合わせは、暗黙に versioning を
強制するのではなく **config 解決時にエラー**として明示させる。
誤デプロイガード（ADR-031 の `account` 必須化）と同じ「暗黙の補正より明示」の
方針に従う。

### 新規 construct `backup.ts`

Backup Vault（KMS 暗号化）+ Backup Plan（日次・月次ルール）+
Backup Selection（S3 バケットと DB を tag ではなく ARN 指定）+ サービスロールを
1 construct にまとめる。`awsBackup: false` の環境では一切生成しない。

**Vault Lock（WORM 化）は現時点では採用しない。** 保持期間中は管理者でも
削除できなくなるため、保持設計の誤りがそのままコスト・コンプライアンス事故に
なる。要件として明示されたときに `overrides` 拡張で追加する。

### Off フローと Vault の扱い（RETAIN + 固定名）

リカバリポイントが残る Backup Vault は AWS 側が削除を拒否するため、
素朴な実装では `awsBackup: false` へ戻した時点で CloudFormation 更新が
失敗する。これを避けるため:

- **Vault は `RemovalPolicy.RETAIN`** — Off 時は削除せず管理から切り離す。
  Plan / Selection は消えるため新規バックアップは即時停止し、取得済み
  リカバリポイントは各自に焼き込まれたライフサイクル（日次35日等）に従って
  自然消滅する。それまでは保管課金が続く（即時にゼロにしたい場合のみ
  Vault 内を手動で空にして削除する）
- **Vault 名は固定 `kukan-<env>-backup`（マルチサイト環境では DB 用が同名で
  SharedStack に、バケット用 `kukan-<env>-<site>-backup` が各 SiteStack に
  分かれる — ADR-041）、再有効化は旧 Vault 削除後に行う** —
  CloudFormation の仕様上 `BackupVaultName` は必須のため、衝突しない
  自動命名はできない（CDK に任せてもコンストラクトパス由来の決定的な
  名前になる）。名前を可変にすると初回と2回目以降で挙動が非対称になる
  ため、固定名とし、旧 Vault が残ったまま再有効化する場合は
  **先に旧 Vault を削除する運用**とする（リカバリポイントの自然消滅を
  待って空になった Vault を削除するか、即時に再開したい場合は
  リカバリポイントを手動削除してから Vault を削除する）

なお Off にしても `s3Versioning` は独立フィールドのため影響を受けない。

## 結果

- 行政要件（誤操作からの復旧・隔離保管・長期世代・監査可能なバックアップ）に
  construct 一式と scale 選択で答えられる
- 既存環境への適用は versioning 有効化・保持日数変更ともに **in-place 更新**で
  安全（リソース置換なし）。AWS Backup の追加も既存リソースに影響しない
- コスト影響: AWS Backup は保管量課金（S3 バックアップ 約 0.06 USD/GB-月、
  DB スナップショットは差分課金）。バージョニングは旧バージョン分の S3 保管費。
  見積りに保管量ベースの逓増項目として計上する
- `small` のまま `overrides: { backup: { awsBackup: { ... } } }` とすれば
  「小規模だが保全要件が厳しい」環境（行政の小規模部署等）にも対応できる

## 関連

- ADR-031: マルチ環境デプロイ（preset + overrides 機構、明示優先の方針）
- ADR-027: CloudFront 再導入（安全側デフォルトの前例）
- 実装: `infra/lib/config.ts` / `infra/lib/constructs/storage.ts` /
  `infra/lib/constructs/database.ts` / `infra/lib/constructs/backup.ts`（新規）
