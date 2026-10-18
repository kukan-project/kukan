// The web's entry in production, beside Next's standalone server.js.
//
// Next reads the address to listen on from HOSTNAME and PORT. Lambda Web
// Functions give it as one AWS_LAMBDA_HTTP_ENDPOINT (`host:port`) instead
// (ADR-068). Elsewhere the container runtime sets HOSTNAME to the container's
// own address, and Next listening only there would miss the health checks that
// come in on localhost, so every interface it is.
const endpoint = process.env.AWS_LAMBDA_HTTP_ENDPOINT
if (endpoint) {
  // An IPv6 host comes bracketed, which listen() does not take
  const parsed = /^\[?(.+?)\]?:(\d+)$/.exec(endpoint)
  if (!parsed) throw new Error(`AWS_LAMBDA_HTTP_ENDPOINT is not host:port: ${endpoint}`)
  process.env.HOSTNAME = parsed[1]
  process.env.PORT = parsed[2]
} else {
  process.env.HOSTNAME = '0.0.0.0'
}
await import('./server.js')
