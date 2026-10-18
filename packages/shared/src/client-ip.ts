/**
 * Request header carrying the viewer's IP, set by the edge (CloudFront
 * viewer-request) over anything the viewer sent.
 *
 * Behind CloudFront `X-Forwarded-For` holds the client and then CloudFront's
 * address, and Better Auth trusts a single value only, so its rate limits
 * resolved no IP and every client shared one bucket. The origin reads this
 * header instead where `CLIENT_IP_HEADER` names it — only behind CloudFront,
 * since anywhere else a client could send it and pick its own bucket.
 */
export const EDGE_CLIENT_IP_HEADER = 'x-kukan-client-ip'
