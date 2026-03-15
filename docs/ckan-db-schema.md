# CKAN Database Schema Reference

> CKAN master ブランチ (2026年時点) の SQLAlchemy モデル定義から抽出。
> KUKAN 設計の参照資料として整理。
>
> Source: https://github.com/ckan/ckan/tree/master/ckan/model
>
> **SQLAlchemy の規約:** `Column()` は明示的に `nullable=False` を指定しない限り NULL 許容。
> 以下のスキーマで `nullable=False` がないカラムはすべて nullable。

## テーブル一覧

| テーブル               | 説明                                             | KUKAN 対応                       |
| ---------------------- | ------------------------------------------------ | -------------------------------- |
| `package`              | データセット                                     | `package`                        |
| `resource`             | リソース（ファイル/URL）                         | `resource`                       |
| `group`                | グループ **＋ 組織**（`is_organization` で区別） | `group` + `organization`（分離） |
| `member`               | 多態的所属（ユーザー→組織、パッケージ→グループ） | 下記4テーブルに分離              |
| `tag`                  | タグ                                             | `tag`                            |
| `package_tag`          | パッケージ×タグ中間テーブル                      | `package_tag`                    |
| `vocabulary`           | タグ語彙（制御語彙）                             | `vocabulary`（未実装）           |
| `user`                 | ユーザー                                         | Better Auth `user`               |
| `api_token`            | APIトークン                                      | `api_token`                      |
| `package_relationship` | パッケージ間リレーション                         | 未実装                           |
| `activity`             | アクティビティストリーム                         | `activity`（スキーマのみ）       |

---

## package（データセット）

```python
package_table = Table('package', meta.metadata,
    Column('id', types.UnicodeText, primary_key=True, default=make_uuid),
    Column('name', types.Unicode(100), nullable=False, unique=True),
    Column('title', types.UnicodeText),
    Column('version', types.Unicode(100)),
    Column('url', types.UnicodeText),
    Column('author', types.UnicodeText),
    Column('author_email', types.UnicodeText),
    Column('maintainer', types.UnicodeText),
    Column('maintainer_email', types.UnicodeText),
    Column('notes', types.UnicodeText),
    Column('license_id', types.UnicodeText),
    Column('type', types.UnicodeText, default='dataset'),
    Column('owner_org', types.UnicodeText),          # 所有組織ID（認可の主軸）
    Column('creator_user_id', types.UnicodeText),    # 作成ユーザーID（記録用）
    Column('metadata_created', types.DateTime, default=utcnow),
    Column('metadata_modified', types.DateTime, default=utcnow),
    Column('private', types.Boolean, default=False),
    Column('state', types.UnicodeText, default='active'),
    Column('plugin_data', JSONB),
    Column('extras', JSONB),  # CHECK: flat object with string values only
    Index('idx_pkg_sid', 'id', 'state'),
    Index('idx_pkg_sname', 'name', 'state'),
    Index('idx_pkg_stitle', 'title', 'state'),
    Index('idx_package_creator_user_id', 'creator_user_id'),
)
```

**設計ポイント:**

- `owner_org` が認可の主軸。組織メンバーシップで編集権限を判定
- `owner_org` は DB 上 nullable だが、アプリケーション層（`ckan/logic/schema.py`）で作成時必須。
  - `package_create`: `owner_org_validator`（`ignore_missing` なし → 必須）
  - `package_update`: `ignore_missing` + `owner_org_validator`（省略可）
  - KUKAN も同パターン: Zod スキーマで作成時必須、DB は nullable
- `creator_user_id` はダッシュボード「My Datasets」表示に使用
- `extras` は JSONB だが文字列値のみ許可する CHECK 制約あり
- `private` は組織内限定公開フラグ（`owner_org` がないと意味なし）
- FK 制約なし（`owner_org` → `group.id`）— アプリケーション層で検証

## resource（リソース）

```python
resource_table = Table('resource', meta.metadata,
    Column('id', types.UnicodeText, primary_key=True, default=make_uuid),
    Column('package_id', types.UnicodeText, ForeignKey('package.id'), nullable=False),
    Column('url', types.UnicodeText, nullable=False),
    Column('format', types.UnicodeText),
    Column('description', types.UnicodeText),
    Column('hash', types.UnicodeText),
    Column('position', types.Integer),
    Column('name', types.UnicodeText),
    Column('resource_type', types.UnicodeText),
    Column('mimetype', types.UnicodeText),
    Column('mimetype_inner', types.UnicodeText),
    Column('size', types.BigInteger),
    Column('created', types.DateTime, default=utcnow),
    Column('last_modified', types.DateTime),
    Column('metadata_modified', types.DateTime, default=utcnow),
    Column('cache_url', types.UnicodeText),
    Column('cache_last_updated', types.DateTime),
    Column('url_type', types.UnicodeText),
    Column('extras', JsonDictType),
    Column('state', types.UnicodeText, default='active'),
    Index('idx_package_resource_id', 'id'),
    Index('idx_package_resource_package_id', 'package_id'),
    Index('idx_package_resource_url', 'url'),
)
```

**設計ポイント:**

- `url` は NOT NULL（KUKAN では optional にしている — ファイルアップロード対応のため）
- `position` でリソースの並び順を管理
- `url_type` は `'upload'`（ファイルストア）/ null（外部URL）を区別
- `mimetype_inner` はアーカイブ内ファイルの MIME タイプ

## group（グループ＋組織）

```python
group_table = Table('group', meta.metadata,
    Column('id', types.UnicodeText, primary_key=True, default=make_uuid),
    Column('name', types.UnicodeText, nullable=False, unique=True),
    Column('title', types.UnicodeText),
    Column('type', types.UnicodeText, nullable=False),     # 'organization' or 'group'
    Column('description', types.UnicodeText),
    Column('image_url', types.UnicodeText),
    Column('created', types.DateTime, default=now),
    Column('is_organization', types.Boolean, default=False),
    Column('approval_status', types.UnicodeText, default='approved'),
    Column('state', types.UnicodeText, default='active'),
    Column('extras', JSONB),  # CHECK: flat object with string values only
    Index('idx_group_id', 'id'),
    Index('idx_group_name', 'name'),
)
```

**設計ポイント:**

- **組織とグループが同一テーブル**。`is_organization` + `type` で区別
- KUKAN では `organization` と `group` に分離（正規化）
- `approval_status` は組織の承認フロー用（デフォルト `'approved'`）

## member（多態的所属）

```python
member_table = Table('member', meta.metadata,
    Column('id', types.UnicodeText, primary_key=True, default=make_uuid),
    Column('table_name', types.UnicodeText, nullable=False),  # 'user' or 'package'
    Column('table_id', types.UnicodeText, nullable=False),     # user ID or package ID
    Column('capacity', types.UnicodeText, nullable=False),     # 'admin','editor','member'
    Column('group_id', types.UnicodeText, ForeignKey('group.id')),
    Column('state', types.UnicodeText, default='active'),
    Index('idx_group_pkg_id', 'table_id'),
    Index('idx_extra_grp_id_pkg_id', 'group_id', 'table_id'),
    Index('idx_package_group_id', 'id'),
)
```

**設計ポイント:**

- 多態的設計: `table_name` + `table_id` で参照先を切り替え
  - `table_name='user'` → ユーザーの組織/グループ所属（capacity = 権限レベル）
  - `table_name='package'` → パッケージのグループ所属
- `group_id` は `group` テーブルへの FK だが、CKAN では組織もグループも同一テーブルなので、組織所属もグループ所属もこの1テーブルで管理される
- KUKAN では組織とグループを別テーブルに分離したため、メンバーシップも4テーブルに分離:

| CKAN `member` の用途  | KUKAN テーブル                 | FK                            |
| --------------------- | ------------------------------ | ----------------------------- |
| ユーザー → 組織       | `user_org_membership`          | `user.id` + `organization.id` |
| ユーザー → グループ   | `user_group_membership`        | `user.id` + `group.id`        |
| パッケージ → グループ | `package_group`                | `package.id` + `group.id`     |
| パッケージ → 組織     | _(FK直接)_ `package.owner_org` | `organization.id`             |

- CKAN の `capacity` カラム → KUKAN の `role` カラム（`admin` / `editor` / `member`）

## tag（タグ）

```python
tag_table = Table('tag', meta.metadata,
    Column('id', types.UnicodeText, primary_key=True, default=make_uuid),
    Column('name', types.Unicode(100), nullable=False),
    Column('vocabulary_id', types.Unicode(100), ForeignKey('vocabulary.id')),
    UniqueConstraint('name', 'vocabulary_id'),
    Index('idx_tag_id', 'id'),
    Index('idx_tag_name', 'name'),
)
```

## package_tag（パッケージ×タグ）

```python
package_tag_table = Table('package_tag', meta.metadata,
    Column('id', types.UnicodeText, primary_key=True, default=make_uuid),
    Column('package_id', types.UnicodeText, ForeignKey('package.id')),
    Column('tag_id', types.UnicodeText, ForeignKey('tag.id')),
    Column('state', types.UnicodeText, default='active'),
    Index('idx_package_tag_id', 'id'),
    Index('idx_package_tag_pkg_id', 'package_id'),
    Index('idx_package_tag_pkg_id_tag_id', 'tag_id', 'package_id'),
)
```

## vocabulary（タグ語彙）

```python
vocabulary_table = Table('vocabulary', meta.metadata,
    Column('id', types.UnicodeText, primary_key=True, default=make_uuid),
    Column('name', types.Unicode(100), nullable=False, unique=True),
)
```

## user（ユーザー）

```python
user_table = Table('user', meta.metadata,
    Column('id', types.UnicodeText, primary_key=True, default=make_uuid),
    Column('name', types.UnicodeText, nullable=False, unique=True),
    Column('password', types.UnicodeText),
    Column('fullname', types.UnicodeText),
    Column('email', types.UnicodeText),
    Column('apikey', types.UnicodeText, default=set_api_key),
    Column('created', types.DateTime, default=now),
    Column('reset_key', types.UnicodeText),
    Column('about', types.UnicodeText),
    Column('last_active', types.TIMESTAMP),
    Column('activity_streams_email_notifications', types.Boolean, default=False),
    Column('sysadmin', types.Boolean, default=False),
    Column('state', types.UnicodeText, default='active', nullable=False),
    Column('image_url', types.UnicodeText),
    Column('plugin_extras', JSONB),
    Index('idx_user_id', 'id'),
    Index('idx_user_name', 'name'),
    Index('idx_only_one_active_email_no_case', func.lower('email'),
          unique=True, postgresql_where="(state = 'active')"),
)
```

**設計ポイント:**

- KUKAN では Better Auth が user テーブルを管理
- `sysadmin` フラグはシステム管理者判定
- email の一意制約は active ユーザーのみ（部分インデックス）

## api_token（APIトークン）

```python
api_token_table = Table('api_token', meta.metadata,
    Column('id', types.UnicodeText, primary_key=True, default=make_token),
    Column('name', types.UnicodeText),
    Column('user_id', types.UnicodeText, ForeignKey('user.id')),
    Column('created_at', types.DateTime, default=utcnow),
    Column('last_access', types.DateTime, nullable=True),
    Column('plugin_extras', JSONB),
)
```

**設計ポイント:**

- `id` がトークン値そのもの（URL-safe ランダム文字列）
- 有効期限カラムなし（KUKAN では `expires_at` を追加）

## package_relationship（パッケージ間リレーション）

```python
package_relationship_table = Table('package_relationship', meta.metadata,
    Column('id', types.UnicodeText, primary_key=True, default=make_uuid),
    Column('subject_package_id', types.UnicodeText, ForeignKey('package.id')),
    Column('object_package_id', types.UnicodeText, ForeignKey('package.id')),
    Column('type', types.UnicodeText),   # 'depends_on','child_of','linked_from' etc.
    Column('comment', types.UnicodeText),
    Column('state', types.UnicodeText, default='active'),
)
```

---

## KUKAN との主な差分

| 観点           | CKAN                                                  | KUKAN                                                                                          |
| -------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 組織/グループ  | 同一テーブル（`is_organization` で区別）              | 別テーブルに分離                                                                               |
| メンバーシップ | 多態的 `member` テーブル（`table_name` で切り替え）   | `user_org_membership` + `user_group_membership` + `package_group` + `package.owner_org` に分離 |
| ユーザー管理   | 自前の `user` テーブル + パスワードハッシュ           | Better Auth                                                                                    |
| APIトークン    | 有効期限なし                                          | `expires_at` カラムあり                                                                        |
| resource.url   | NOT NULL                                              | nullable（ファイルアップロード対応）                                                           |
| PK 型          | UnicodeText (UUID文字列)                              | UUID 型                                                                                        |
| タイムスタンプ | DateTime (naive)                                      | TIMESTAMPTZ (timezone-aware)                                                                   |
| 拡張フィールド | `extras` JSONB + `plugin_data` / `plugin_extras`      | `extras` JSONB のみ                                                                            |
| カラム命名     | snake_case                                            | snake_case（Drizzle では camelCase にマッピング）                                              |
| package 日時   | `metadata_created` / `metadata_modified`              | `created` / `updated`（KUKAN 共通規約に統一）                                                  |
| 検索戦略       | Solr に全面委譲（一覧・フィルター・キーワードすべて） | DB 直接（一覧・フィルター） + SearchAdapter（キーワード全文検索のみ）。ADR-013 参照            |
