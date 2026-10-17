// Lambda Web Functions probe, step 1: can the web's query path stand here at all?
//
// Answers, without DuckDB, what KUKAN's web assumes of its host:
//   - fork() of a child (services/child/host.ts) and its OOM score write (serve.ts)
//   - a cgroup memory limit to read (process-memory.ts), and whether a child's
//     memory shows in the parent's cgroup (capacity.ts assumes it does)
//   - /tmp as the spill directory (childEnvironment points TMPDIR there)
//   - arch / libc, for which DuckDB binding would have to ship
//
// Every route needs the token in token.txt (written by deploy.sh), because the
// default endpoint is public and /alloc spends memory on request.
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import v8 from 'node:v8'
import { fork, execFile } from 'node:child_process'

const __dirname = import.meta.dirname

const STARTED = Date.now()
const TOKEN = (() => {
  try {
    return fs.readFileSync(path.join(__dirname, 'token.txt'), 'utf8').trim()
  } catch {
    return ''
  }
})()

function read(p) {
  try {
    return fs.readFileSync(p, 'utf8').trim()
  } catch (e) {
    return `!${e.code ?? e.message}`
  }
}

// The same two paths and the same order as packages/api/src/process-memory.ts
function cgroup() {
  const v2stat = read('/sys/fs/cgroup/memory.stat')
  const v1stat = read('/sys/fs/cgroup/memory/memory.stat')
  return {
    selfCgroup: read('/proc/self/cgroup'),
    v2: {
      memoryMax: read('/sys/fs/cgroup/memory.max'),
      memoryCurrent: read('/sys/fs/cgroup/memory.current'),
      anonMb: mb(/^anon (\d+)$/m.exec(v2stat)?.[1]),
      cpuMax: read('/sys/fs/cgroup/cpu.max'),
      pidsMax: read('/sys/fs/cgroup/pids.max'),
    },
    v1: {
      limitInBytes: read('/sys/fs/cgroup/memory/memory.limit_in_bytes'),
      totalRssMb: mb(/^total_rss (\d+)$/m.exec(v1stat)?.[1]),
    },
  }
}

function mb(bytes) {
  return bytes === undefined ? null : Math.round(Number(bytes) / 1024 / 1024)
}

function statfs(p) {
  try {
    const s = fs.statfsSync(p)
    return { totalMb: mb(s.blocks * s.bsize), freeMb: mb(s.bavail * s.bsize) }
  } catch (e) {
    return `!${e.code ?? e.message}`
  }
}

function writable(dir) {
  const f = path.join(dir, `.probe-${process.pid}-${Date.now()}`)
  try {
    fs.writeFileSync(f, 'x')
    fs.unlinkSync(f)
    return true
  } catch (e) {
    return `!${e.code ?? e.message}`
  }
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout, stderr) =>
      resolve(err ? `!${err.code ?? err.message} ${stderr}`.trim() : stdout.trim())
    )
  })
}

// Names only: the environment holds the execution role's credentials
function envNames() {
  const shown = ['AWS_LAMBDA_HTTP_ENDPOINT', 'AWS_REGION', 'NODE_OPTIONS', 'TMPDIR', 'HOME']
  return {
    names: Object.keys(process.env).sort(),
    values: Object.fromEntries(shown.map((k) => [k, process.env[k] ?? null])),
  }
}

async function probe() {
  const report = process.report.getReport()
  return {
    startupMs: listenedAt - STARTED,
    uptimeS: Math.round(process.uptime()),
    pid: process.pid,
    uid: process.getuid?.(),
    node: process.version,
    arch: process.arch,
    glibcRuntime: report.header.glibcVersionRuntime ?? null,
    osRelease: read('/etc/os-release'),
    uname: await run('uname', ['-a']),
    cpus: os.cpus().length,
    availableParallelism: os.availableParallelism(),
    totalmemMb: mb(os.totalmem()),
    freememMb: mb(os.freemem()),
    meminfo: read('/proc/meminfo').split('\n').slice(0, 5),
    rssMb: mb(process.memoryUsage().rss),
    heapLimitMb: mb(v8.getHeapStatistics().heap_size_limit),
    cgroup: cgroup(),
    limits: read('/proc/self/limits').split('\n'),
    status: read('/proc/self/status')
      .split('\n')
      .filter((l) => /^(Seccomp|NoNewPrivs|Cap(Eff|Bnd)|Threads)/.test(l)),
    fs: {
      cwd: process.cwd(),
      dirname: __dirname,
      tmp: statfs(os.tmpdir()),
      tmpdir: os.tmpdir(),
      tmpWritable: writable(os.tmpdir()),
      codeWritable: writable(__dirname),
      devShm: statfs('/dev/shm'),
    },
    env: envNames(),
    shell: await run('/bin/sh', ['-c', 'echo sh-ok']),
    ldd: await run('ldd', ['--version']),
  }
}

// One child per call, like the web's resource queries (ADR-032 remaining issue 2)
function withChild(msg, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const t0 = Date.now()
    let child
    try {
      child = fork(path.join(__dirname, 'child.js'), [], {
        env: { PATH: process.env.PATH, TMPDIR: os.tmpdir() },
        execArgv: [],
      })
    } catch (e) {
      resolve({ forkError: e.code ?? e.message })
      return
    }
    let reply = null
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('message', (m) => {
      if (m.ready) {
        child.send(msg)
        return
      }
      reply = m
      child.disconnect()
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ spawnError: e.code ?? e.message, elapsedMs: Date.now() - t0 })
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({
        reply,
        exit: { code, signal },
        elapsedMs: Date.now() - t0,
        parentAfter: cgroup().v2,
      })
    })
  })
}

let listenedAt = 0

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://probe')
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body, null, 2))
  }
  if (!TOKEN || req.headers['x-probe-token'] !== TOKEN) return send(403, { error: 'token' })
  const n = Math.max(0, Math.min(Number(url.searchParams.get('mb') ?? 0) || 0, 4096))
  try {
    switch (url.pathname) {
      case '/sleep': {
        // Holds the request for ?ms= (max 10 s), so a burst stays in flight at once:
        // measures how many requests an environment takes concurrently
        const ms = Math.min(Number(url.searchParams.get('ms') ?? 1000) || 0, 10_000)
        await new Promise((r) => setTimeout(r, ms))
        return send(200, { pid: process.pid, ms })
      }
      case '/probe':
        return send(200, await probe())
      case '/fork':
        // A child that only reports: does fork work, and can it raise its OOM score
        return send(200, { parentBefore: cgroup().v2, ...(await withChild({ op: 'report' })) })
      case '/alloc':
        // Child allocates and touches n MB: where is the ceiling, and who dies at it
        return send(200, {
          parentBefore: cgroup().v2,
          ...(await withChild({ op: 'alloc', mb: n })),
        })
      case '/tmp':
        // Child writes n MB to TMPDIR, like a DuckDB spill
        return send(200, {
          before: statfs(os.tmpdir()),
          ...(await withChild({ op: 'spill', mb: n })),
        })
      default:
        return send(404, { routes: ['/probe', '/fork', '/alloc?mb=N', '/tmp?mb=N', '/sleep?ms=N'] })
    }
  } catch (e) {
    return send(500, { error: e.stack })
  }
})

const [host, port] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || 'localhost:3000').split(':')
server.listen(Number(port), host, () => {
  listenedAt = Date.now()
  console.log(JSON.stringify({ msg: 'listening', host, port, startupMs: listenedAt - STARTED }))
})
process.on('SIGTERM', () => {
  console.log(JSON.stringify({ msg: 'sigterm', uptimeS: Math.round(process.uptime()) }))
  process.exit(0)
})
