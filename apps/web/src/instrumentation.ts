// Once per server process, before it serves anything: secrets the runtime did
// not inject (Lambda Web Functions) are read here so that every reader of
// process.env sees them, not only the API (packages/api/src/secrets.ts)
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  // The module alone: the API's barrel would load every route here
  const { loadSecrets } = await import('@kukan/api/secrets')
  await loadSecrets()
}
