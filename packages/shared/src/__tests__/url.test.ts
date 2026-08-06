/**
 * The one table, for the one list.
 *
 * These cases lived twice — once against the worker's `isBlockedAddress` and
 * once against the resource validator — and the two drifted: the worker learned
 * about IPv4-mapped addresses, zone identifiers and IMDS-over-IPv6 while the
 * validator did not. Keeping the table here, beside the predicate both sides
 * call, is what stops that happening again.
 */
import { describe, it, expect } from 'vitest'
import { isBlockedAddress, checkUrlSafety } from '../url'

describe('isBlockedAddress', () => {
  describe('IPv4', () => {
    it.each([
      ['127.0.0.1', 'loopback'],
      ['127.255.255.255', 'loopback, top of the range'],
      ['169.254.169.254', 'AWS IMDS'],
      ['169.254.0.1', 'link-local'],
      ['0.0.0.0', 'unspecified'],
      ['0.1.2.3', 'unspecified, the rest of 0/8'],
    ])('should block %s (%s)', (address) => {
      expect(isBlockedAddress(address)).toBe(true)
    })

    it.each([
      ['10.0.0.1', 'private, allowed on purpose for intranet deployments'],
      ['172.16.0.1', 'private, the bottom of 172.16/12'],
      ['192.168.1.1', 'private'],
      ['8.8.8.8', 'public'],
      ['203.0.113.1', 'public, and adjacent to nothing blocked'],
    ])('should allow %s (%s)', (address) => {
      expect(isBlockedAddress(address)).toBe(false)
    })
  })

  describe('IPv6', () => {
    it.each([
      ['::1', 'loopback'],
      ['0:0:0:0:0:0:0:1', 'loopback, uncompressed'],
      ['::', 'unspecified'],
      ['fe80::1', 'link-local'],
      ['fe90::1', 'link-local, mid-range'],
      ['febf::1', 'link-local, top of the range'],
      ['::1%lo', 'a zone identifier is not part of the address'],
      ['[::1]', 'as URL.hostname spells it'],
      ['fd00:ec2::254', 'AWS IMDS over IPv6, inside the ULA range allowed below'],
      ['fd00:ec2::23', 'AWS IMDS over IPv6, the other well-known one'],
    ])('should block %s (%s)', (address) => {
      expect(isBlockedAddress(address)).toBe(true)
    })

    it.each([
      ['fc00::1', 'ULA, allowed on purpose'],
      ['fd00::1', 'ULA, and one byte from the IMDS prefix above'],
      ['fd12:3456::1', 'ULA with a random global id, the ordinary case'],
      ['2001:db8::1', 'documentation range'],
      ['2606:2800:220::1', 'public'],
      ['fec0::1', 'site-local: deprecated, and not ours to block'],
    ])('should allow %s (%s)', (address) => {
      expect(isBlockedAddress(address)).toBe(false)
    })
  })

  describe('addresses carrying an IPv4 one', () => {
    // Judged on what they carry, not on the prefix. Blocking `64:ff9b::/96`
    // outright would refuse the internet on a NAT64 network.
    it.each([
      ['::ffff:127.0.0.1', 'IPv4-mapped, dotted'],
      ['::ffff:7f00:1', 'IPv4-mapped, hex — the form URL normalises to'],
      ['::ffff:169.254.169.254', 'IPv4-mapped IMDS'],
      ['::ffff:a9fe:a9fe', 'IPv4-mapped IMDS, hex'],
      ['::127.0.0.1', 'IPv4-compatible, deprecated'],
      ['::7f00:1', 'IPv4-compatible, hex'],
      ['64:ff9b::127.0.0.1', 'NAT64'],
      ['64:ff9b::7f00:1', 'NAT64, hex'],
      ['64:ff9b::a9fe:a9fe', 'NAT64 IMDS'],
      ['2002:7f00:1::1', '6to4, which carries its IPv4 higher up'],
    ])('should block %s (%s)', (address) => {
      expect(isBlockedAddress(address)).toBe(true)
    })

    it.each([
      ['::ffff:8.8.8.8', 'IPv4-mapped public — not caught by ::/96'],
      ['64:ff9b::8.8.8.8', 'NAT64 to a public address is how that network works'],
      ['2002:0808:0808::1', '6to4 to a public address'],
    ])('should allow %s (%s)', (address) => {
      expect(isBlockedAddress(address)).toBe(false)
    })
  })

  it.each(['example.com', '', 'not-an-ip', '999.1.1.1', '1.2.3', '::gggg', '1::2::3'])(
    'should answer false for %s, which is not an address',
    (input) => {
      // What lets `checkUrlSafety` hand it a bare hostname.
      expect(isBlockedAddress(input)).toBe(false)
    }
  )
})

describe('checkUrlSafety', () => {
  // Asserting on `reason` rather than "something was refused": the reasons are
  // what the API branches on to pick a message, so a refusal arriving under the
  // wrong one is a wrong message with a passing test.
  it.each([
    'http://127.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fd00:ec2::254]/',
    'http://0177.0.0.1/', // URL normalises the obfuscated spellings
    'http://2130706433/',
    'http://127.1/',
  ])('should refuse %s as an address', (url) => {
    expect(checkUrlSafety(url)?.reason).toBe('address')
  })

  it.each([
    'http://localhost/',
    'http://LOCALHOST./', // a trailing dot is the same name to a resolver
    'http://metadata.google.internal/',
  ])('should refuse %s by name', (url) => {
    expect(checkUrlSafety(url)?.reason).toBe('hostname')
  })

  it.each(['ftp://example.com/', 'file:///etc/passwd', 'gopher://example.com/'])(
    'should refuse %s for its scheme',
    (url) => {
      expect(checkUrlSafety(url)?.reason).toBe('protocol')
    }
  )

  it('should report a string that is not a URL', () => {
    expect(checkUrlSafety('not a url')?.reason).toBe('invalid')
  })

  it.each([
    'https://example.com/data.csv',
    'http://10.0.0.1/data.csv', // private is allowed for intranet deployments
    'http://[fc00::1]/data.csv',
    'https://user:pw@example.com/data.csv',
  ])('should allow %s', (url) => {
    expect(checkUrlSafety(url)).toBeNull()
  })

  it('should carry a message for logs alongside the reason', () => {
    expect(checkUrlSafety('ftp://example.com/')?.message).toContain('Unsupported protocol')
  })
})
