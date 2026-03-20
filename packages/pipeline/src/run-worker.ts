/**
 * Generic utility to run a worker thread and receive a single result.
 */

import { Worker } from 'node:worker_threads'

export function runWorker<TInput, TOutput>(workerPath: string, input: TInput): Promise<TOutput> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerPath)
    worker.on('message', (result: TOutput) => {
      resolve(result)
      void worker.terminate()
    })
    worker.on('error', reject)
    worker.on('exit', (code) => {
      if (code !== 0) reject(new Error(`Worker exited with code ${code}`))
    })
    worker.postMessage(input)
  })
}
