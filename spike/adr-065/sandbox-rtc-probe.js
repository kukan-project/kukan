// The probe page's WebRTC probe (?rtc=<turn url>): whether code in the sandboxed
// frame can reach a TURN server, the channel CSP does not cover. It runs before
// the boot page removes WebRTC and loads ibisOffice (module scripts run in
// order), and keeps no reference afterwards. Only the probe page loads it; the
// secure boot page takes no query at all.
const target = new URLSearchParams(location.search).get('rtc')
if (target) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: target, username: 'document-bytes', credential: 'x' }],
  })
  pc.createDataChannel('x')
  await pc.setLocalDescription(await pc.createOffer())
}

// ?memMax=<pages>: try another ceiling on ibisOffice's WASM memory.
const memMax = Number(new URLSearchParams(location.search).get('memMax'))
if (memMax > 0) globalThis.__memMaxPages = memMax

// ?dns=<hostname>: ask for a DNS prefetch of a name that could carry data, as a
// compromised renderer could with createElement and appendChild. With
// X-DNS-Prefetch-Control: off on this page, no lookup should be made.
const dnsName = new URLSearchParams(location.search).get('dns')
if (dnsName) {
  const link = document.createElement('link')
  link.rel = 'dns-prefetch'
  link.href = `//${dnsName}`
  document.head.append(link)
}
