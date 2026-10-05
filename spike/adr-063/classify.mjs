// Can column roles for the table profile (ADR-063 decision 1) be decided by
// rules? Reads every CSV/TSV with a stored schema from the local dev stack
// (Postgres in the kukan-postgres container, preview Parquet in MinIO),
// measures each string column with DuckDB, classifies it, and prints counts
// and examples per class for review.
//
//   node spike/adr-063/classify.mjs [--examples 12]
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const root = new URL('../../', import.meta.url).pathname
const require = createRequire(`${root}apps/worker/package.json`)
const { DuckDBInstance } = require('@duckdb/node-api')
const EXAMPLES = Number(process.argv[process.argv.indexOf('--examples') + 1]) || 12

const env = Object.fromEntries(
  readFileSync(`${root}.env`, 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z0-9_]+=/.test(l))
    .map((l) => [
      l.slice(0, l.indexOf('=')),
      l.slice(l.indexOf('=') + 1).replace(/^["']|["']$/g, ''),
    ])
)

const rows = JSON.parse(
  execFileSync('docker', [
    'exec',
    'kukan-postgres',
    'psql',
    '-U',
    'kukan',
    '-d',
    'kukan',
    '-At',
    '-c',
    `SELECT coalesce(json_agg(json_build_object('resource', p.resource_id, 'name', r.name,
              'key', p.preview_key, 'schema', p.metadata->'schema')), '[]')
     FROM resource_pipeline p JOIN resource r ON r.id = p.resource_id
     WHERE p.metadata ? 'schema' AND p.preview_key LIKE '%.parquet'`,
  ]).toString()
)

const db = await (await DuckDBInstance.create(':memory:')).connect()
const endpoint = env.S3_ENDPOINT.replace(/^https?:\/\//, '')
await db.run(`CREATE SECRET (TYPE s3, KEY_ID '${env.S3_ACCESS_KEY}', SECRET '${env.S3_SECRET_KEY}',
  ENDPOINT '${endpoint}', URL_STYLE 'path', USE_SSL false, REGION 'us-east-1')`)

const HINT = {
  free: /備考|概要|説明|内容|コメント|摘要|特記|注記|詳細|理由|メモ/,
  id: /コード|番号|ＩＤ|ID|Ｎｏ|No\.?$|識別|郵便/i,
  name: /名称|名$|氏名|施設|事業名|店名/,
}

/** The rules under test. */
function classify(c, m) {
  if (c.type !== 'string') return 'numeric/date'
  if (!m || m.n === 0) return 'empty'
  const ratio = m.d / m.n
  // Numbers written with commas, brackets, dashes or units stay strings in type inference.
  if (m.numlike >= 0.9) return 'numeric (as text)'
  if (m.datelike >= 0.9) return 'numeric/date'
  if (m.url >= 0.8 || m.phone >= 0.8) return 'identifier'
  if (
    // Length alone also catches long names; prose has punctuation or runs of hiragana.
    (m.avglen >= 20 && m.ascii < 0.5 && (m.punct >= 0.1 || m.hira >= 0.3)) ||
    m.punct >= 0.3 ||
    (HINT.free.test(c.name) && m.avglen >= 6) ||
    (m.hira >= 0.5 && ratio >= 0.5 && m.avglen >= 8)
  )
    return 'free text'
  if (
    (m.ascii >= 0.95 &&
      (ratio >= 0.9 || (m.minlen === m.maxlen && m.digits >= 0.9 && ratio >= 0.5))) ||
    (HINT.id.test(c.name) && m.ascii >= 0.9)
  )
    return 'identifier'
  if (m.ja >= 0.5 && ratio >= 0.5 && m.d >= 30) return 'name'
  return 'category'
}

const q = (s) => `"${s.replaceAll('"', '""')}"`
const out = []
let failed = 0
for (const r of rows) {
  const url = `s3://${env.S3_BUCKET}/${r.key}`
  for (const c of r.schema.columns) {
    let m = null
    let top = []
    if (c.type === 'string') {
      try {
        const col = q(c.name)
        const res = await db.runAndReadAll(`
          SELECT count(${col}) AS n, count(DISTINCT ${col}) AS d,
                 avg(length(${col})) AS avglen, min(length(${col})) AS minlen, max(length(${col})) AS maxlen,
                 avg(CASE WHEN regexp_full_match(${col}, '[0-9A-Za-z._/:\\-]+') THEN 1 ELSE 0 END) AS ascii,
                 avg(CASE WHEN regexp_full_match(${col}, '[0-9０-９]+') THEN 1 ELSE 0 END) AS digits,
                 avg(CASE WHEN regexp_matches(${col}, '[ぁ-んァ-ヶ一-龠]') THEN 1 ELSE 0 END) AS ja,
                 avg(CASE WHEN regexp_matches(${col}, '[。、．，]') THEN 1 ELSE 0 END) AS punct,
                 avg(CASE WHEN regexp_matches(${col}, '[ぁ-ん]{2,}') THEN 1 ELSE 0 END) AS hira,
                 avg(CASE WHEN regexp_full_match(${col}, '^https?://\\S+$') THEN 1 ELSE 0 END) AS url,
                 avg(CASE WHEN regexp_full_match(trim(${col}), '0[0-9]{1,4}[-−‐－(（][0-9]{1,4}[-−‐－)）][0-9]{3,4}.*') THEN 1 ELSE 0 END) AS phone,
                 avg(CASE WHEN regexp_full_match(trim(${col}),
                   '([0-9]{4}|[RHSrhs令平昭][和成][0-9０-９元]{1,2}|令和[0-9０-９元]{1,2}|平成[0-9０-９元]{1,2})[/／.．年-][0-9０-９]{1,2}([/／.．月-][0-9０-９]{1,2}日?)?') THEN 1 ELSE 0 END) AS datelike,
                 avg(CASE WHEN regexp_full_match(trim(${col}),
                   '[-−‐－▲△+＋]?\\s*[(（]?[0-9０-９][0-9０-９,，.．]*[)）]?\\s*[%％]?|[-−‐－…・*＊xX×]+') THEN 1 ELSE 0 END) AS numlike
          FROM read_parquet('${url}') WHERE ${col} IS NOT NULL AND ${col} <> ''`)
        const [x] = res.getRowObjectsJson()
        m = Object.fromEntries(Object.entries(x).map(([k, v]) => [k, v === null ? 0 : Number(v)]))
        top = (
          await db.runAndReadAll(`SELECT ${col} AS v FROM read_parquet('${url}')
            WHERE ${col} IS NOT NULL AND ${col} <> '' GROUP BY 1 ORDER BY count(*) DESC LIMIT 4`)
        )
          .getRowObjectsJson()
          .map((o) => String(o.v).slice(0, 30))
      } catch (e) {
        failed++
        if (failed <= 3)
          console.error(`not measured: ${c.name}: ${String(e.message).split('\n')[0]}`)
      }
    }
    out.push({ resource: r.name, column: c.name, type: c.type, class: classify(c, m), m, top })
  }
}

const by = (k) => out.reduce((a, x) => ((a[x[k]] = (a[x[k]] ?? 0) + 1), a), {})
console.log(`${rows.length} tables, ${out.length} columns, ${failed} string columns not measured`)
console.table(Object.entries(by('class')).map(([cls, n]) => ({ class: cls, columns: n })))

const show = (title, xs) => {
  console.log(`\n## ${title} (${xs.length})`)
  for (const x of xs.slice(0, EXAMPLES))
    console.log(
      `  ${x.column} [${x.m ? `n=${x.m.n} d=${x.m.d} avg=${x.m.avglen.toFixed(1)} ascii=${x.m.ascii.toFixed(2)} ja=${x.m.ja.toFixed(2)}` : ''}] ${x.top.join(' | ')}`
    )
}
const pick = (cls) => out.filter((x) => x.class === cls).sort(() => Math.random() - 0.5)
for (const cls of ['free text', 'identifier', 'name', 'category', 'numeric (as text)'])
  show(cls, pick(cls))
show(
  'category with more than 1,000 distinct values',
  out.filter((x) => x.class === 'category' && x.m?.d > 1000)
)
show(
  'name with more than 1,000 distinct values',
  out.filter((x) => x.class === 'name' && x.m?.d > 1000)
)
show(
  'category that looks like codes (ascii >= 0.95)',
  out.filter((x) => x.class === 'category' && x.m?.ascii >= 0.95)
)

writeFileSync(new URL('./results-classify.json', import.meta.url), JSON.stringify(out, null, 2))
