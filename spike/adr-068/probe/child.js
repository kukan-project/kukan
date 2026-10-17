// Forked by index.js. Mirrors what packages/api/src/services/child/serve.ts does
// on start (raise its own OOM score), then runs one operation and reports.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function mb(bytes) {
  return Math.round(bytes / 1024 / 1024)
}

function anonMb() {
  try {
    const m = /^anon (\d+)$/m.exec(fs.readFileSync('/sys/fs/cgroup/memory.stat', 'utf8'))
    return m ? mb(Number(m[1])) : null
  } catch {
    return null
  }
}

let oomScoreAdj
try {
  fs.writeFileSync('/proc/self/oom_score_adj', '1000')
  oomScoreAdj = fs.readFileSync('/proc/self/oom_score_adj', 'utf8').trim()
} catch (e) {
  oomScoreAdj = `!${e.code ?? e.message}`
}

process.on('message', (msg) => {
  const base = { pid: process.pid, ppid: process.ppid, oomScoreAdj, tmpdir: os.tmpdir() }
  if (msg.op === 'report') {
    process.send({ ...base, rssMb: mb(process.memoryUsage().rss), cgroupAnonMb: anonMb() })
    return
  }
  if (msg.op === 'alloc') {
    // Off-heap Buffers, touched page by page, like native allocations by DuckDB
    const chunks = []
    const steps = []
    for (let i = 0; i < msg.mb; i += 64) {
      const b = Buffer.allocUnsafe(Math.min(64, msg.mb - i) * 1024 * 1024)
      b.fill(1)
      chunks.push(b)
      steps.push({
        allocatedMb: i + b.length / 1024 / 1024,
        rssMb: mb(process.memoryUsage().rss),
        cgroupAnonMb: anonMb(),
      })
    }
    process.send({ ...base, steps: steps.filter((_, i) => i % 4 === 3 || i === steps.length - 1) })
    return
  }
  if (msg.op === 'spill') {
    const f = path.join(os.tmpdir(), `spill-${process.pid}.bin`)
    const block = Buffer.alloc(1024 * 1024, 1)
    let written = 0
    let error = null
    try {
      const fd = fs.openSync(f, 'w')
      for (; written < msg.mb; written++) fs.writeSync(fd, block)
      fs.closeSync(fd)
    } catch (e) {
      error = e.code ?? e.message
    }
    const s = fs.statfsSync(os.tmpdir())
    fs.rmSync(f, { force: true })
    process.send({ ...base, writtenMb: written, error, freeMbAtPeak: mb(s.bavail * s.bsize) })
  }
})

process.send({ ready: true })
