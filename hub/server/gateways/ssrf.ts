import dns from 'dns/promises';
import net from 'net';

/**
 * Security H1 + #10: Strict outbound SSRF egress guard for Hub MCP Gateway & Ollama/LLM endpoints.
 * Handles IPv4 and full 128-bit IPv6 parsing (including hex/dotted IPv4-mapped `::ffff:0:0/96`,
 * `[::1]` URL brackets, `fe80::/10`, `fc00::/7`, `ff00::/8`, `64:ff9b::/96`).
 */

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    throw new Error(`Invalid IPv4 address: ${ip}`);
  }
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0);
}

function intToIpv4(n: number): string {
  return `${(n >>> 24) & 255}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
}

export function isIpv4InCidr(ip: string, cidr: string): boolean {
  const [netIp, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr || '32', 10);
  if (Number.isNaN(prefix) || prefix < 0 || prefix > 32) return false;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(netIp) & mask);
}

function ipv6ToBigInt(rawIp: string): bigint {
  const clean = rawIp.split('%')[0].toLowerCase();
  // Convert trailing dotted-quad IPv4 (e.g. ::ffff:169.254.169.254) into two 16-bit hex groups
  const lastColon = clean.lastIndexOf(':');
  let normalized = clean;
  if (lastColon !== -1 && clean.slice(lastColon + 1).includes('.')) {
    const v4 = ipv4ToInt(clean.slice(lastColon + 1));
    normalized = `${clean.slice(0, lastColon)}:${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) throw new Error(`Invalid IPv6: ${rawIp}`);
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - (left.length + right.length);
  if (missing < 0 || (halves.length === 1 && missing !== 0)) {
    throw new Error(`Invalid IPv6: ${rawIp}`);
  }
  const groups = [...left, ...new Array(missing).fill('0'), ...right];
  let out = 0n;
  for (const g of groups) {
    const val = parseInt(g || '0', 16);
    if (Number.isNaN(val) || val < 0 || val > 0xffff) throw new Error(`Invalid IPv6 group: ${g}`);
    out = (out << 16n) | BigInt(val);
  }
  return out;
}

function isIpv6InCidr(ipBig: bigint, cidr: string): boolean {
  const [netStr, prefixStr] = cidr.split('/');
  const prefix = parseInt(prefixStr || '128', 10);
  const netBig = ipv6ToBigInt(netStr);
  const shift = BigInt(128 - prefix);
  return (ipBig >> shift) === (netBig >> shift);
}

const ALWAYS_BLOCKED_V4_CIDRS = [
  '0.0.0.0/8',       // "This" network
  '127.0.0.0/8',     // Loopback
  '169.254.0.0/16',  // Cloud IMDS & link-local (CRITICAL!)
  '100.64.0.0/10',   // CGNAT / internal cloud routing
  '224.0.0.0/4',     // Multicast
  '240.0.0.0/4'      // Reserved
];

const RFC1918_V4_CIDRS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'];

const ALWAYS_BLOCKED_V6_CIDRS = [
  '::/128',          // Unspecified
  '::1/128',         // Loopback
  'fc00::/7',        // Unique local (private)
  'fe80::/10',       // Link-local (fe80..febf)
  'ff00::/8',        // Multicast
  '64:ff9b::/96'     // NAT64
];

export interface SsrfPolicy {
  allowHttp?: boolean;
  allowedPrivateCidrs?: string[];
  blockedCidrs?: string[];
}

export function assertIpAllowed(rawIp: string, policy: SsrfPolicy = {}): void {
  const ip = rawIp.replace(/^\[|\]$/g, '');
  if (net.isIPv6(ip)) {
    const big = ipv6ToBigInt(ip);
    // IPv4-mapped IPv6 (`::ffff:0:0/96`, both dotted and hex `::ffff:a9fe:a9fe`) -> validate embedded IPv4!
    if (isIpv6InCidr(big, '::ffff:0:0/96')) {
      const embeddedV4 = intToIpv4(Number(big & 0xffffffffn));
      assertIpAllowed(embeddedV4, policy);
      return;
    }
    if (ALWAYS_BLOCKED_V6_CIDRS.some((c) => isIpv6InCidr(big, c))) {
      throw new Error(`SSRF blocked: destination IPv6 ${ip} is forbidden`);
    }
    return;
  }
  if (!net.isIPv4(ip)) {
    throw new Error(`SSRF blocked: invalid resolved IP ${ip}`);
  }
  if (ALWAYS_BLOCKED_V4_CIDRS.some((c) => isIpv4InCidr(ip, c))) {
    throw new Error(`SSRF blocked: destination IP ${ip} is in a forbidden range (IMDS/loopback/link-local)`);
  }
  if ((policy.blockedCidrs || []).some((c) => isIpv4InCidr(ip, c))) {
    throw new Error(`SSRF blocked: destination IP ${ip} is in a blocked internal subnet`);
  }
  const isRfc1918 = RFC1918_V4_CIDRS.some((c) => isIpv4InCidr(ip, c));
  if (isRfc1918) {
    const allowed = (policy.allowedPrivateCidrs || []).some((c) => isIpv4InCidr(ip, c));
    if (!allowed) {
      throw new Error(`SSRF blocked: private RFC1918 destination ${ip} is not in HUB_ALLOWED_PRIVATE_CIDRS`);
    }
  }
}

export async function assertSafeOutboundUrl(rawUrl: string, policy: SsrfPolicy = {}): Promise<{
  url: URL;
  resolvedIps: string[];
}> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  const allowedProtocols = policy.allowHttp ? ['https:', 'http:'] : ['https:'];
  if (!allowedProtocols.includes(url.protocol)) {
    throw new Error(`SSRF blocked: protocol ${url.protocol} not allowed (HTTPS required)`);
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'metadata.google.internal' ||
    host.endsWith('.internal')
  ) {
    throw new Error(`SSRF blocked: forbidden hostname ${host}`);
  }

  if (net.isIP(host)) {
    assertIpAllowed(host, policy);
    return { url, resolvedIps: [host] };
  }

  const records = await dns.lookup(host, { all: true, verbatim: true });
  if (!records.length) {
    throw new Error(`DNS resolution failed for ${host}`);
  }
  const ips = records.map((r) => r.address);
  for (const ip of ips) {
    assertIpAllowed(ip, policy);
  }
  return { url, resolvedIps: ips };
}
