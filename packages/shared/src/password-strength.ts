/**
 * Password strength policy.
 *
 * Follows NIST SP 800-63B's shape — no character-composition rules, no forced
 * rotation, length and guessability deciding instead — at the length the
 * current revision asks of a password used without a second factor, which is
 * what this deployment has. The guessability check is additional to the spec:
 * a floor alone would still admit `passwordpassword`.
 *
 * Existing accounts are unaffected until they set a new password. Sign-in is
 * never scored, and the change form does not measure the current password, so
 * an account created under an older floor keeps working and can move off it.
 *
 * The server gate and the client meter both come through here, so a password
 * the meter accepts is not one the server then refuses.
 */

import { z } from 'zod'
import type { ZxcvbnFactory } from '@zxcvbn-ts/core'

/** Hard floor, in code points. Anything shorter is rejected whatever it scores. */
export const PASSWORD_MIN_LENGTH = 15
/**
 * Ceiling, passed to Better Auth as `maxPasswordLength` so the two agree, and
 * refused here too — a password the meter passed and the endpoint then rejected
 * on length would surface as an unexplained failure. Counted in UTF-16 units
 * rather than code points, because that is what Better Auth counts and the
 * looser of the two readings would let through what it then refuses.
 * Scoring stops well before it — see {@link SCORED_LENGTH}.
 */
export const PASSWORD_MAX_LENGTH = 128
/**
 * The form the password is stored in. Better Auth normalizes NFKC before
 * hashing, so a policy that reads the raw string is not describing the secret
 * that ends up on the account: full-width `ｐａｓｓｗｏｒｄ１２３` scores 4 while
 * hashing to the same value as `password123`.
 */
export function normalizePassword(password: string): string {
  return password.normalize('NFKC')
}

/**
 * Characters as a person counts them, on the stored form. `String.length`
 * counts UTF-16 units, so it reads six emoji as twelve characters — a floor
 * measured that way is half the floor it claims to be.
 */
export function passwordLength(password: string): number {
  return Array.from(normalizePassword(password)).length
}
/** zxcvbn score (0-4) required to pass. 3 = "safely unguessable". */
export const PASSWORD_MIN_SCORE = 3

/**
 * How much of the password the matcher looks at, and how far it will chase l33t
 * substitutions. Both are cost controls, and the cost is not linear: measured on
 * this dictionary set, a 128 character `p@ssw0rd`-style string took 8.4 seconds
 * of blocking CPU at the library defaults (256 / 100), and 28 seconds at 1 KB.
 * The endpoint runs before Better Auth's own length check, so that CPU was
 * reachable unauthenticated. At 64 / 3 the same input costs 86 ms, and the
 * scores of the passwords the suite pins are unchanged.
 *
 * Levenshtein matching is off for the same reason — measured 20x on a short
 * password (201 ms against 9 ms) and +34 MB resident, to catch near-misses of
 * dictionary words that the l33t and reversal matchers largely already cover.
 */
const SCORED_LENGTH = 64
const L33T_MAX_SUBSTITUTIONS = 3

/**
 * `PASSWORD_MIN_SCORE` as an environment override. Lowering it to 0 leaves only
 * the length floor, which is how a local or throwaway environment gets to keep
 * using scratch passwords without the production default being weakened.
 */
export const passwordMinScoreSchema = z
  .preprocess((value) => (value === '' ? undefined : value), z.coerce.number().int().min(0).max(4))
  .default(PASSWORD_MIN_SCORE)

/**
 * The threshold in force. Lives beside the schema because the API and the
 * `db:create-user` script both need it and `@kukan/db` cannot reach into the
 * API. `envSchema` carries the same field so a malformed value fails at boot
 * rather than on the first password.
 */
export function passwordMinScore(): number {
  return passwordMinScoreSchema.parse(process.env.PASSWORD_MIN_SCORE)
}

/**
 * The length rules as a schema, so every form, route and script counts the same
 * way. Guessability is not in here: it needs the dictionaries, and a schema
 * cannot await them.
 *
 * The two messages are separate because a form that reports "too short" for a
 * password that was too long tells the user to do the opposite of what would
 * work. Callers hand in whatever their layer displays —
 * an i18n key on the client, prose on the server.
 */
export function passwordLengthSchema(
  messages: { tooShort: string; tooLong: string } = {
    tooShort: `Password must be at least ${PASSWORD_MIN_LENGTH} characters`,
    tooLong: `Password must be at most ${PASSWORD_MAX_LENGTH} characters`,
  }
) {
  return (
    z
      .string()
      // Only the floor needs a hand-written rule: it counts code points
      .refine((value) => passwordLength(value) >= PASSWORD_MIN_LENGTH, {
        message: messages.tooShort,
      })
      .max(PASSWORD_MAX_LENGTH, { message: messages.tooLong })
  )
}

/** Locale of the feedback text; dictionaries are language-independent here. */
export type PasswordFeedbackLocale = 'en' | 'ja'

export interface PasswordStrength {
  /** 0 (too guessable) to 4 (very unguessable) */
  score: 0 | 1 | 2 | 3 | 4
  /** Whether the policy accepts this password */
  acceptable: boolean
  /** The single most relevant problem, already translated */
  warning: string | null
  /** Ways to improve it, already translated */
  suggestions: string[]
}

const checkers = new Map<PasswordFeedbackLocale, Promise<ZxcvbnFactory>>()

/**
 * The dictionaries weigh several MB, so they load on first use — on the client
 * that keeps them out of the initial bundle. Both language dictionaries load
 * whatever the locale is: a Japanese-derived password must score the same for
 * an English UI, or the two sides would disagree.
 */
function loadChecker(locale: PasswordFeedbackLocale): Promise<ZxcvbnFactory> {
  const cached = checkers.get(locale)
  if (cached) return cached
  const loading = (async () => {
    const [core, common, en, ja] = await Promise.all([
      import('@zxcvbn-ts/core'),
      import('@zxcvbn-ts/language-common'),
      import('@zxcvbn-ts/language-en'),
      import('@zxcvbn-ts/language-ja'),
    ])
    return new core.ZxcvbnFactory({
      graphs: common.adjacencyGraphs,
      dictionary: { ...common.dictionary, ...en.dictionary, ...ja.dictionary },
      translations: locale === 'ja' ? ja.translations : en.translations,
      maxLength: SCORED_LENGTH,
      l33tMaxSubstitutions: L33T_MAX_SUBSTITUTIONS,
    })
  })()
  checkers.set(locale, loading)
  return loading
}

/**
 * Account details a password must not be derived from. Passing the address
 * whole is not enough — zxcvbn scores `taro-yamada` in `taro@example.com`
 * only when the local part is listed on its own.
 *
 * The display name counts as much as the username: it is the string a person
 * is most likely to build a password out of, and it is on the screen next to
 * the field.
 */
export function passwordUserInputs(account: {
  email?: string | null
  name?: string | null
  displayName?: string | null
}): string[] {
  const inputs = [account.name, account.displayName, account.email]
  const localPart = account.email?.split('@')[0]
  if (localPart) inputs.push(localPart)
  return inputs.filter((v): v is string => !!v)
}

/**
 * The guessability gate as the server applies it: the account details are
 * derived here, and a floor of zero means there is nothing to ask — so the
 * dictionaries, tens of MB held for the life of the process, never load in an
 * environment that opted out.
 *
 * Returns null when the check does not apply. Length is not judged here; the
 * callers each have a schema or an endpoint that reports it by name.
 */
export async function checkPasswordGuessability(
  password: string,
  account: { email?: string | null; name?: string | null; displayName?: string | null }
): Promise<PasswordStrength | null> {
  const minScore = passwordMinScore()
  if (minScore <= 0) return null
  return evaluatePassword(password, { userInputs: passwordUserInputs(account), minScore })
}

export async function evaluatePassword(
  password: string,
  options: {
    userInputs?: string[]
    locale?: PasswordFeedbackLocale
    /** Score to accept from; defaults to {@link PASSWORD_MIN_SCORE}. */
    minScore?: number
  } = {}
): Promise<PasswordStrength> {
  const { userInputs = [], locale = 'en', minScore = PASSWORD_MIN_SCORE } = options
  const checker = await loadChecker(locale)
  // Score what gets hashed, and compare it against the account details in the
  // same form — otherwise a full-width spelling of the account name reads as
  // unrelated to it
  const result = checker.check(normalizePassword(password), userInputs.map(normalizePassword))
  const withinLength =
    // The ceiling is measured raw, because that is what Better Auth measures:
    // the looser of the two readings would pass what the endpoint then refuses
    passwordLength(password) >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH
  return {
    score: result.score,
    acceptable: withinLength && result.score >= minScore,
    warning: result.feedback.warning ?? null,
    suggestions: result.feedback.suggestions,
  }
}
