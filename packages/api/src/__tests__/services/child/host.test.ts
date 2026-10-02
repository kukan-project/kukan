import { describe, it, expect } from 'vitest'
import { fork } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { overBudget } from '../../../services/child/host'

describe('overBudget', () => {
  it('stops a child past its own budget, wherever it runs', () => {
    expect(overBudget(600, null, 588, 16_384, 32)).toBe('child')
    expect(overBudget(500, null, 588, 16_384, 32)).toBeNull()
  })

  it('stops a child once the container nears its limit, whatever the child holds', () => {
    // A 512 MB task: the parent and the child together, as the OOM killer counts them
    expect(overBudget(250, 512 - 32 + 1, 588, 512, 32)).toBe('container')
    expect(overBudget(250, 512 - 32 - 1, 588, 512, 32)).toBeNull()
  })
})

describe('becomeExpendable', () => {
  /** A child that only calls it, says so, and then waits for whatever comes. */
  function startChild() {
    const child = fork(join(import.meta.dirname, 'expendable-child.ts'), [], {
      execArgv: ['--import', 'tsx'],
      // Where `--import tsx` resolves from this package's devDependencies
      cwd: join(import.meta.dirname, '../../../..'),
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    const ready = new Promise<void>((resolve) => child.once('message', () => resolve()))
    const exited = new Promise<number | null>((resolve) => child.once('exit', resolve))
    return { child, ready, exited }
  }

  it.skipIf(process.platform !== 'linux')(
    'makes it the process the OOM killer picks first',
    async () => {
      const { child, ready, exited } = startChild()
      await ready
      const score = (await readFile(`/proc/${child.pid}/oom_score_adj`, 'utf8')).trim()
      child.kill()
      await exited
      expect(score).toBe('1000')
    }
  )

  it('ends the child when its parent goes', async () => {
    const { child, ready, exited } = startChild()
    await ready
    // What the child sees when the parent dies: the channel closes
    child.disconnect()
    expect(await exited).toBe(0)
  })
})
