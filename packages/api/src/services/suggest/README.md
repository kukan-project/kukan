# AI Metadata Suggestions — Limits and Flow Reference (English / 日本語)

The limits the ADR-040 implementation (plus the per-resource parallel
generation addendum) carries, and where each one applies in the request flow.
See ADR-040 for the "why" behind the design decisions; change values in this
table and `packages/api/src/config.ts` together.

## Overall flow

```
POST /packages/:id/suggest-metadata
  │  auth → editor permission → rate limit [SUGGEST_RATE_LIMIT: 60/user/1h,
  │  counted per request — the completions inside don't multiply it]
  ▼
suggest() starts … deadlineAt = now + SUGGEST_TOTAL_DEADLINE_MS (110s)
  │
  ├─ Material collection collectMaterials()
  │    Splits resources into described (own suggestion slot) and others
  │    (name/format context only)
  │    [SUGGEST_MAX_RESOURCES: 20] … content-bearing resources get slots first
  │    Per-resource material clamps:
  │      textHead      [SUGGEST_TEXT_HEAD_BYTES: 16KB read]
  │      sample rows   [SUGGEST_SAMPLE_ROWS: 5 × SUGGEST_SAMPLE_CELL_CHARS: 200 chars/cell]
  │      columns       [SUGGEST_MAX_COLUMNS: 20] (applied in buildUserContent)
  │      ZIP           [SUGGEST_ZIP_MANIFEST_ENTRIES: 50 / SUGGEST_ZIP_MANIFEST_MAX_BYTES: 5MB]
  │      metadata      [MAX_MATERIAL_NAME_CHARS: 200 / MAX_MATERIAL_URL_CHARS: 500 /
  │                     MAX_MATERIAL_TAGS: 30 / MAX_TITLE_LENGTH: 200 / MAX_NOTES_LENGTH: 4000]
  │
  ├─ Candidate fetch (concurrent)
  │    tag candidates   [SUGGEST_TAG_CANDIDATES: 30] (by usage)
  │    group candidates [SUGGEST_GROUP_CANDIDATES: 100] (SQL-ordered by usage
  │                     desc, name asc; name + title + description, the
  │                     title/description clamped to 200 chars)
  │
  ├─ Phase 1: one completion per resource (parallel)
  │    concurrency [suggestConcurrency: ollama=2 / others=4]
  │    launch gate: phase1Deadline = deadlineAt − SUGGEST_PHASE2_RESERVE_MS (30s)
  │                 remaining < SUGGEST_MIN_CALL_MS (5s) → skip, degrade to context
  │    input budget [SUGGEST_RESOURCE_PROMPT_BYTES: 32KB]
  │                 trim order when over: textHead halved→dropped → sample rows
  │                 → file list → schema
  │    output cap [SUGGEST_RESOURCE_MAX_TOKENS: 800]
  │    failure / all-blank → resource joins others and the flow continues
  │    (503 only when every resource fails)
  │
  ├─ Phase 2: integration completion (once)
  │    deadline: max(deadlineAt, now + 30s) … the reserve survives even when
  │    Phase 1 ate the budget
  │    input budget [SUGGEST_DATASET_PROMPT_BYTES: 32KB]
  │                 trim order when over: others → group-candidate tail →
  │                 tag-candidate tail → descriptions to
  │                 TRIMMED_DESCRIPTION_CHARS (100) → trailing resources
  │    output cap [SUGGEST_DATASET_MAX_TOKENS: 2,000]
  │    no category yet + candidates exist → prompt requires the best single
  │    pick (requireGroup)
  │
  ├─ Post-processing postProcess
  │    tags   … current values kept first + additions [MAX_TAGS: 5 total /
  │             MAX_NEW_TAGS: 2] — the caps gate additions only
  │    groups … current values kept + in-candidate additions [MAX_GROUPS: 3
  │             total, same rule]. A title match resolves to the name only
  │             when unique among candidates; out-of-candidate values are
  │             discarded (warn). requireGroup with zero additions →
  │             regenerate the integration once → still empty is accepted
  │    name   … drafts only. normalize → validate against PACKAGE_NAME_*
  │             (shared) → uniqueness in one batched query
  │             [NAME_SUFFIX_ATTEMPTS: 8 suffix candidates]
  │    length clamps [MAX_TITLE_LENGTH: 200 / MAX_NOTES_LENGTH: 4000 /
  │                   MAX_DESCRIPTION_LENGTH: 1000 / MAX_TAG_LENGTH: 200]
  ▼
response (suggestions are never persisted; usedResources / skippedResources
included)
```

## Time-budget accounting (deadline scheme)

The deadline is fixed once as an **absolute time**; every attempt recomputes
the remaining time just before it starts. No number of retries can push the
total past the deadline.

| Constant                      | Value      | Role                                                               |
| ----------------------------- | ---------- | ------------------------------------------------------------------ |
| `SUGGEST_TOTAL_DEADLINE_MS`   | 110s       | Wall-clock ceiling for the whole request                           |
| `SUGGEST_PHASE2_RESERVE_MS`   | 30s        | Reserved slot for the integration call — Phase 1 cannot touch it   |
| `SUGGEST_MIN_CALL_MS`         | 5s         | No new attempt starts with less remaining time than this           |
| `SUGGEST_TIMEOUT_MS`          | 120s       | Per-attempt ceiling (effective value: min(this, remaining))        |
| `SUGGEST_THROTTLE_BACKOFF_MS` | [0.5s, 2s] | Backoff on throttling (429/Throttling); array length = retry count |

Three kinds of retries exist, all under the same remaining-time accounting:
throttle retries (up to 2) / invalid-JSON retry (1) / requireGroup
regeneration (1).

Known limitation: CloudFront (default 30s) and ALB (default 60s) give up
sooner than this budget, so a slow cloud generation can time out at the edge
(accepted; the permanent fix ships with async delivery).

## Easy-to-confuse interactions

- **`SUGGEST_MAX_RESOURCES` (20) is not a model constraint.** Under
  single-call generation it was derived from the output-token ceiling; after
  parallelization it is a cost / latency / review-UX cap. Raising it needs no
  envelope redesign (but CPU Ollama total time scales with the count)
- **Input budget (32KB) vs textHead (16KB read)**: 16KB is the byte count
  _read_; Shift_JIS→UTF-8 conversion can grow it up to 1.5×, and 32KB leaves
  room for that
- **Output caps are ceilings against JSON breakage, not targets.** Hitting
  the cap truncates the JSON mid-object and destroys the whole response, so
  the caps sit several times above the real output. The description length
  itself is controlled by the prompt (1–3 sentences, ~300 chars)
- **Tag/category count caps gate additions only** (additions-only principle).
  Current values above the cap are never dropped; additions just stop
- **The candidate lists come in two parts**: the prompt-side copy (which the
  budget ladder may trim) and the full validation list (used by `selectTags`
  / `selectGroups`) are separate. A pick trimmed out of the prompt still
  validates
- **The 100-group candidate cap is deliberate.** SQL orders by usage before
  the limit, so _which_ 100 is deterministic. Raise the constant when a site
  exceeds it

## Related files

- Constants: `packages/api/src/config.ts` (`--- AI metadata suggestions ---` section)
- Service-side clamps (response lengths, material metadata): the constants at
  the top of `metadata-suggest-service.ts`
- Prompts and output schemas: `suggest/prompt.ts`
- The name contract (`PACKAGE_NAME_*`): `packages/shared/src/validators/package.ts`
- Rate limiting: `suggest/rate-limit.ts`
- Quality evaluation (golden set): `packages/api/scripts/eval-suggest.ts`
  (`pnpm eval:suggest`; copy `golden-suggest.example.yaml`)

---

# AI メタデータ提案 — リミットと動作フローのリファレンス

ADR-040（+ リソース単位並列生成の追記）の実装が持つ制限値の一覧と、
それらがリクエスト処理のどこで効くかのまとめ。設計判断の「なぜ」は
ADR-040 を、値の変更はこの表と `packages/api/src/config.ts` を見る。

## 全体フロー

```
POST /packages/:id/suggest-metadata
  │  認証 → editor 権限 → レート制限 [SUGGEST_RATE_LIMIT: 60回/1h/ユーザー、
  │  リクエスト単位でカウント — 内部の completion 数は掛からない]
  ▼
suggest() 開始 … deadlineAt = now + SUGGEST_TOTAL_DEADLINE_MS (110s)
  │
  ├─ 素材収集 collectMaterials()
  │    リソースを described（提案スロットあり）と others（name/format のみ）に分割
  │    [SUGGEST_MAX_RESOURCES: 20] … content 保有リソース優先でスロット割当
  │    リソースごとの素材クランプ:
  │      textHead      [SUGGEST_TEXT_HEAD_BYTES: 16KB 読み]
  │      サンプル行     [SUGGEST_SAMPLE_ROWS: 5行 × SUGGEST_SAMPLE_CELL_CHARS: 200字/セル]
  │      列            [SUGGEST_MAX_COLUMNS: 20列]（buildUserContent 時に適用）
  │      ZIP           [SUGGEST_ZIP_MANIFEST_ENTRIES: 50件 / SUGGEST_ZIP_MANIFEST_MAX_BYTES: 5MB]
  │      メタデータ     [MAX_MATERIAL_NAME_CHARS: 200 / MAX_MATERIAL_URL_CHARS: 500 /
  │                     MAX_MATERIAL_TAGS: 30 / MAX_TITLE_LENGTH: 200 / MAX_NOTES_LENGTH: 4000]
  │
  ├─ 候補取得（並行）
  │    タグ候補   [SUGGEST_TAG_CANDIDATES: 30]（使用数順）
  │    グループ候補 [SUGGEST_GROUP_CANDIDATES: 100]（SQL で使用数降順・name 昇順、
  │               name + title + description、title/description は 200 字クランプ）
  │
  ├─ Phase 1: リソースごとの completion（並列）
  │    並列度 [suggestConcurrency: ollama=2 / それ以外=4]
  │    起動判定: phase1Deadline = deadlineAt − SUGGEST_PHASE2_RESERVE_MS (30s)
  │             残り < SUGGEST_MIN_CALL_MS (5s) なら起動せず context に降格
  │    入力予算 [SUGGEST_RESOURCE_PROMPT_BYTES: 32KB]
  │             超過時のトリム順: textHead 半減→破棄 → サンプル行 → ファイル一覧 → スキーマ
  │    出力上限 [SUGGEST_RESOURCE_MAX_TOKENS: 800]
  │    失敗・全空白 → そのリソースは others 扱いで続行（全滅時のみ 503）
  │
  ├─ Phase 2: 統合 completion（1回）
  │    デッドライン: max(deadlineAt, now + 30s) … Phase 1 が食い潰しても予約枠は確保
  │    入力予算 [SUGGEST_DATASET_PROMPT_BYTES: 32KB]
  │             超過時のトリム順: others → グループ候補末尾 → タグ候補末尾
  │             → description を TRIMMED_DESCRIPTION_CHARS (100字) に短縮 → 末尾リソース削除
  │    出力上限 [SUGGEST_DATASET_MAX_TOKENS: 2,000]
  │    カテゴリー未設定 + 候補あり → 「最適1件」をプロンプトで要求（requireGroup）
  │
  ├─ 後処理 postProcess
  │    tags   … 現在値を先頭に保持 + 追加分 [MAX_TAGS: 5 合計 / MAX_NEW_TAGS: 2]
  │             ※上限は追加分にのみ作用（現在値は落とさない）
  │    groups … 現在値を保持 + 候補内の追加分 [MAX_GROUPS: 3 合計、同上]
  │             title 一致は候補内で一意な場合のみ name に解決。候補外は破棄（warn）
  │             requireGroup で追加ゼロ → 統合を1回だけ再生成 → それでも空なら受理
  │    name   … draft のみ。正規化 → PACKAGE_NAME_*（shared）検証 →
  │             一意性を一括クエリで確認 [NAME_SUFFIX_ATTEMPTS: 8 個のサフィックス候補]
  │    長さクランプ [MAX_TITLE_LENGTH: 200 / MAX_NOTES_LENGTH: 4000 /
  │                 MAX_DESCRIPTION_LENGTH: 1000 / MAX_TAG_LENGTH: 200]
  ▼
応答（提案は非永続。usedResources / skippedResources を併記）
```

## 時間予算の会計（デッドライン方式）

締切は**絶対時刻**として1回だけ決め、以降は毎試行の直前に残り時間を再計算する。
リトライが何回起きても合計はデッドラインを超えない。

| 定数                          | 値         | 役割                                                                  |
| ----------------------------- | ---------- | --------------------------------------------------------------------- |
| `SUGGEST_TOTAL_DEADLINE_MS`   | 110 秒     | リクエスト全体の壁時計上限                                            |
| `SUGGEST_PHASE2_RESERVE_MS`   | 30 秒      | 統合呼び出しの予約枠。Phase 1 はここに手を出せない                    |
| `SUGGEST_MIN_CALL_MS`         | 5 秒       | これ未満の残時間では新しい試行を開始しない                            |
| `SUGGEST_TIMEOUT_MS`          | 120 秒     | 1試行の上限（実効値は min(これ, 残時間)）                             |
| `SUGGEST_THROTTLE_BACKOFF_MS` | [0.5s, 2s] | スロットリング（429/Throttling）時のバックオフ。配列長 = リトライ回数 |

試行の種類は3つあり、すべて同じ残時間会計に従う:
スロットリングリトライ（最大2回）/ 不正 JSON リトライ（1回）/ requireGroup 再生成(1回)。

既知の制約: CloudFront（既定 30 秒）・ALB（既定 60 秒）はこの予算より短いため、
遅いクラウド生成は edge 側でタイムアウトし得る（受容済み。恒久対応は非同期化）。

## リミット間の関係で混乱しやすい点

- **`SUGGEST_MAX_RESOURCES`（20）はモデル制約ではない**。一括生成時代は出力
  トークン逆算の天井だったが、並列化後はコスト・時間・レビュー UX の上限。
  引き上げても封筒設計の変更は不要（ただし CPU Ollama の合計時間は件数比例）
- **入力予算（32KB）と textHead（16KB 読み）の関係**: 16KB は「読むバイト数」で、
  Shift_JIS→UTF-8 変換で最大 1.5 倍に膨らむため、32KB はそれを収める余裕込み
- **出力上限は「目標」ではなく「JSON 破壊防止の天井」**。上限到達 = JSON が
  オブジェクト途中で切断され全体が壊れるため、実出力の数倍を確保してある。
  説明文の長さ自体はプロンプト指示（1〜3文・~300字）で制御する
- **タグ/カテゴリーの件数上限は追加分にのみ作用**（追加専用の原則）。現在値が
  既に上限以上でも削除はされず、追加が入らなくなるだけ
- **候補リストは2部構成**: プロンプトに渡すコピー（予算ラダーで削られ得る）と
  検証用の完全リスト（`selectTags` / `selectGroups` が参照）は別物。プロンプト
  から削られた候補を LLM が選んでも検証は通る
- **グループ候補の 100 件上限は意図的なキャップ**。SQL で使用数順に整列して
  から切るため「どの 100 件か」は決定的。100 超のサイトが現れたら定数を上げる

## 関連ファイル

- 定数定義: `packages/api/src/config.ts`（`--- AI metadata suggestions ---` セクション）
- サービス内クランプ（応答長・素材メタデータ）: `metadata-suggest-service.ts` 冒頭の定数
- プロンプト・出力スキーマ: `suggest/prompt.ts`
- name 契約（`PACKAGE_NAME_*`）: `packages/shared/src/validators/package.ts`
- レート制限: `suggest/rate-limit.ts`
- 品質評価（ゴールデンセット）: `packages/api/scripts/eval-suggest.ts`
  （`pnpm eval:suggest`。`golden-suggest.example.yaml` をコピーして使う）
