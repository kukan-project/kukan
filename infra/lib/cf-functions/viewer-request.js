/* eslint-disable */
// CloudFront Function — Viewer Request
// 1. Access control: pass when source IP is in ALLOWED *or* Basic auth matches.
// 2. Cache bypass: inject unique header when session cookie is present.
//
// ALLOWED (IP ranges) and BASIC_AUTH (the full expected `Basic <base64>` header) are
// injected by CDK at synth time (see constructs/cdn.ts). Both empty → access control skipped.
var ALLOWED = []
var BASIC_AUTH = ''

function handler(event) {
  // --- Access control: IP allowlist OR Basic auth ---
  if (ALLOWED.length || BASIC_AUTH) {
    var passIp = false
    if (ALLOWED.length) {
      var ip = event.viewer.ip
      for (var i = 0; i < ALLOWED.length; i++) {
        if (cidr(ip, ALLOWED[i])) {
          passIp = true
          break
        }
      }
    }
    var passAuth = false
    if (BASIC_AUTH) {
      var h = event.request.headers.authorization
      if (h && h.value === BASIC_AUTH) passAuth = true
    }
    if (!passIp && !passAuth) {
      // 401 (not 403) when Basic auth is configured so the browser prompts for credentials.
      if (BASIC_AUTH) {
        return {
          statusCode: 401,
          statusDescription: 'Unauthorized',
          headers: { 'www-authenticate': { value: 'Basic realm="KUKAN"' } },
        }
      }
      return { statusCode: 403, statusDescription: 'Forbidden' }
    }
  }

  // --- Cookie-based cache bypass ---
  // Any authenticated request must bypass the edge cache so personalized SSR
  // HTML is never stored and served to other users. Match the Better Auth
  // session cookie by the `.session_token` suffix (covers `better-auth.session_token`,
  // `__Secure-better-auth.session_token`, and any configured `<prefix>.session_token`)
  // rather than a substring — a substring match would let any client inject the
  // bypass with a cookie like `xsession_tokenx` and force cache misses.
  // `slice` (not `endsWith`) for CloudFront Functions runtime compatibility.
  var req = event.request
  var SUFFIX = '.session_token'
  for (var name in req.cookies) {
    if (name === 'session_token' || name.slice(-SUFFIX.length) === SUFFIX) {
      req.headers['x-cache-bypass'] = { value: '' + Date.now() }
      break
    }
  }
  return req
}

// --- CIDR matching (IPv4 + IPv6) ---

function cidr(ip, range) {
  var s = range.indexOf('/')
  var base = s < 0 ? range : range.substring(0, s)
  var isV6 = ip.indexOf(':') >= 0
  if (isV6 !== base.indexOf(':') >= 0) return false
  if (!isV6) {
    var bits = s < 0 ? 32 : parseInt(range.substring(s + 1), 10)
    var a = ip.split('.'),
      b = base.split('.')
    var ipN = ((+a[0] << 24) | (+a[1] << 16) | (+a[2] << 8) | +a[3]) >>> 0
    var bN = ((+b[0] << 24) | (+b[1] << 16) | (+b[2] << 8) | +b[3]) >>> 0
    var m = bits ? (~0 << (32 - bits)) >>> 0 : 0
    return (ipN & m) === (bN & m)
  }
  var bits6 = s < 0 ? 128 : parseInt(range.substring(s + 1), 10)
  var ab = expandV6(ip),
    bb = expandV6(base)
  var full = bits6 >> 3
  for (var j = 0; j < full; j++) if (ab[j] !== bb[j]) return false
  var rem = bits6 & 7
  if (rem) {
    var mk = (0xff << (8 - rem)) & 0xff
    if ((ab[full] & mk) !== (bb[full] & mk)) return false
  }
  return true
}

function expandV6(addr) {
  var halves = addr.split('::')
  var groups
  if (halves.length === 2) {
    var left = halves[0] ? halves[0].split(':') : []
    var right = halves[1] ? halves[1].split(':') : []
    groups = left.slice()
    for (var i = 0; i < 8 - left.length - right.length; i++) groups.push('0')
    groups = groups.concat(right)
  } else {
    groups = addr.split(':')
  }
  var bytes = []
  for (var k = 0; k < groups.length; k++) {
    var n = parseInt(groups[k], 16) || 0
    bytes.push((n >> 8) & 0xff, n & 0xff)
  }
  return bytes
}
