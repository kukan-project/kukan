/**
 * Run in the browser before the app (Next's client instrumentation).
 *
 * Zod compiles an object schema's checks with `new Function` when it may, and
 * finds out whether it may by trying once, when the first object schema is
 * built — at module load, on any page whose code builds one. Under the pages'
 * CSP (ADR-071), which has no 'unsafe-eval', that try is reported as a
 * violation. Jitless, Zod neither tries nor compiles; the setting is read as
 * each schema is built, so it is made here, ahead of every module. The forms
 * here are too small for the compiled checks to matter. From the core, which
 * holds the one config `zod` reads, so that every page does not load all of Zod.
 */
import { config } from 'zod/v4/core'

config({ jitless: true })
