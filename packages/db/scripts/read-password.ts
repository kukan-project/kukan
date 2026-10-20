/**
 * Where `db:create-user` takes the password from: an environment variable, or
 * a prompt that does not echo. Never the command line, where it would stay in
 * the shell history and be readable by anyone on the host through `ps`.
 */

import { StringDecoder } from 'node:string_decoder'

export const PASSWORD_ENV = 'KUKAN_USER_PASSWORD'

export class PasswordInputError extends Error {}

export interface PasswordSource {
  env: Record<string, string | undefined>
  /** Whether a person is at the terminal to answer a prompt */
  interactive: boolean
  prompt: (question: string) => Promise<string>
}

export async function readPassword({ env, interactive, prompt }: PasswordSource): Promise<string> {
  const fromEnv = env[PASSWORD_ENV]
  if (fromEnv) return fromEnv
  if (!interactive) {
    throw new PasswordInputError(
      `No password: set ${PASSWORD_ENV}, or run from a terminal to be prompted for it.`
    )
  }
  const password = await prompt('Password: ')
  if (!password) throw new PasswordInputError('No password entered.')
  // Typed blind, so asked twice: a typo would otherwise lock the account out
  if ((await prompt('Confirm password: ')) !== password) {
    throw new PasswordInputError('The passwords did not match.')
  }
  return password
}

/** Reads one line from a TTY with echo off. */
export function promptHidden(
  question: string,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout
): Promise<string> {
  return new Promise((resolve, reject) => {
    output.write(question)
    let value = ''
    // A terminal can split a multibyte character across chunks; the decoder
    // holds the partial bytes until the rest arrives
    const decoder = new StringDecoder('utf8')
    const done = (err: Error | null) => {
      input.off('data', onData)
      input.setRawMode(false)
      input.pause()
      output.write('\n')
      if (err) reject(err)
      else resolve(value)
    }
    const onData = (chunk: Buffer) => {
      for (const ch of decoder.write(chunk)) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done(null)
        if (ch === '\u0003') return done(new PasswordInputError('Cancelled.'))
        if (ch === '\u007f' || ch === '\b') value = Array.from(value).slice(0, -1).join('')
        else value += ch
      }
    }
    input.setRawMode(true)
    input.resume()
    input.on('data', onData)
  })
}
