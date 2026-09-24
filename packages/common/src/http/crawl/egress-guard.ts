import type { Agent as HttpAgent } from 'http';
import type { Agent as HttpsAgent } from 'https';

/**
 * True for loopback, RFC 1918, link-local, CGNAT, ULA, multicast, unspecified,
 * and the IPv4-mapped IPv6 forms of these. Spec 1690 — lane B2.
 */
export function isPrivateAddress(ip: string): boolean {
  throw new Error('not implemented (Spec 1690 lane B2)');
}

/**
 * Throws `EgressBlockedError` for `localhost`, `*.local`, `*.internal`,
 * `*.svc.cluster.local`, dotless names and private IP literals.
 */
export function assertPublicHostname(hostname: string): void {
  throw new Error('not implemented (Spec 1690 lane B2)');
}

/**
 * Shared keep-alive agents whose DNS `lookup` refuses private addresses (defeats
 * DNS rebinding for direct connections). `insecureTls` mirrors the pre-1690
 * `caCert` behaviour (rejectUnauthorized: false).
 */
export function getGuardedAgents(options: { insecureTls: boolean }): { httpAgent: HttpAgent; httpsAgent: HttpsAgent } {
  throw new Error('not implemented (Spec 1690 lane B2)');
}
