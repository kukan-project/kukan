import { PassThrough } from 'node:stream'
import { describe, it, expect, vi } from 'vitest'
import { PASSWORD_ENV, PasswordInputError, promptHidden, readPassword } from '../read-password'

const answers = (...values: string[]) => {
  const prompt = vi.fn<(q: string) => Promise<string>>()
  for (const v of values) prompt.mockResolvedValueOnce(v)
  return prompt
}

describe('readPassword', () => {
  it('takes the environment variable without prompting', async () => {
    const prompt = answers()
    await expect(
      readPassword({ env: { [PASSWORD_ENV]: 'from-env' }, interactive: true, prompt })
    ).resolves.toBe('from-env')
    expect(prompt).not.toHaveBeenCalled()
  })

  it('prompts twice at a terminal and returns the password when both match', async () => {
    const prompt = answers('typed-secret', 'typed-secret')
    await expect(readPassword({ env: {}, interactive: true, prompt })).resolves.toBe('typed-secret')
    expect(prompt).toHaveBeenCalledTimes(2)
  })

  it('refuses when the confirmation differs', async () => {
    const prompt = answers('typed-secret', 'typed-secreT')
    await expect(readPassword({ env: {}, interactive: true, prompt })).rejects.toThrow(
      'did not match'
    )
  })

  it('refuses an empty answer', async () => {
    await expect(
      readPassword({ env: {}, interactive: true, prompt: answers('') })
    ).rejects.toBeInstanceOf(PasswordInputError)
  })

  it('says where to put the password when there is neither a variable nor a terminal', async () => {
    await expect(readPassword({ env: {}, interactive: false, prompt: answers() })).rejects.toThrow(
      PASSWORD_ENV
    )
  })
})

/** A stand-in TTY: a stream with the raw-mode switch the prompt flips. */
function fakeTty() {
  const input = Object.assign(new PassThrough(), {
    setRawMode: vi.fn(),
  }) as unknown as NodeJS.ReadStream & { setRawMode: ReturnType<typeof vi.fn> }
  const written: string[] = []
  const output = {
    write: (s: string) => {
      written.push(s)
      return true
    },
  } as unknown as NodeJS.WriteStream
  return { input, output, written }
}

describe('promptHidden', () => {
  it('reads up to Enter in raw mode, applies backspace, and echoes nothing typed', async () => {
    const { input, output, written } = fakeTty()
    const answer = promptHidden('Password: ', input, output)
    input.write('secrex\u007ft\rignored')
    await expect(answer).resolves.toBe('secret')
    expect(input.setRawMode).toHaveBeenNthCalledWith(1, true)
    expect(input.setRawMode).toHaveBeenLastCalledWith(false)
    expect(written.join('')).toBe('Password: \n')
  })

  it('keeps a character whose bytes arrive in separate chunks', async () => {
    const { input, output } = fakeTty()
    const answer = promptHidden('Password: ', input, output)
    const bytes = Buffer.from('パスワード\r')
    // Split inside the first character's three bytes, and again inside a later one
    input.write(bytes.subarray(0, 1))
    input.write(bytes.subarray(1, 7))
    input.write(bytes.subarray(7))
    await expect(answer).resolves.toBe('パスワード')
  })

  it('gives up on Ctrl-C', async () => {
    const { input, output } = fakeTty()
    const answer = promptHidden('Password: ', input, output)
    input.write('abc\u0003')
    await expect(answer).rejects.toThrow('Cancelled')
  })
})
