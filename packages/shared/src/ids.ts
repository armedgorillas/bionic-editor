import crypto from 'crypto';

/**
 * Crockford Base32 alphabet (lowercase) for RFC 1123 DNS-safe ULIDs.
 * Every Bionic Hub ID uses a lowercase hyphenated prefix (`prj-<ulid>`)
 * so it can be embedded directly in DNS labels (<prj-id>.editors.<domain>).
 */
const CROCKFORD_LOWER = '0123456789abcdefghjkmnpqrstvwxyz';

export type IdPrefix = 'prj' | 'pub' | 'run' | 'dat' | 'usr' | 'grp' | 'rev' | 'job' | 'tok' | 'ses';

export function generateUlid(nowMs: number = Date.now()): string {
  // 48-bit timestamp -> 10 Crockford Base32 chars
  let ts = Math.max(0, Math.floor(nowMs));
  const timeChars = new Array<string>(10);
  for (let i = 9; i >= 0; i--) {
    timeChars[i] = CROCKFORD_LOWER[ts % 32];
    ts = Math.floor(ts / 32);
  }

  // 80-bit cryptographic randomness -> 16 Crockford Base32 chars
  const randBytes = crypto.randomBytes(10);
  const randChars = new Array<string>(16);
  let bitBuffer = 0;
  let bitCount = 0;
  let outIdx = 0;
  for (const byte of randBytes) {
    bitBuffer = (bitBuffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5 && outIdx < 16) {
      bitCount -= 5;
      randChars[outIdx++] = CROCKFORD_LOWER[(bitBuffer >>> bitCount) & 0x1f];
    }
  }

  return timeChars.join('') + randChars.join('');
}

export function generateShortId(length = 8): string {
  // Cryptographic random Crockford Base32 chars (5 bits/char; 8 chars = 40 bits = ~1.1T IDs)
  const byteCount = Math.ceil((length * 5) / 8);
  const randBytes = crypto.randomBytes(byteCount);
  const chars = new Array<string>(length);
  let bitBuffer = 0;
  let bitCount = 0;
  let outIdx = 0;
  for (const byte of randBytes) {
    bitBuffer = (bitBuffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5 && outIdx < length) {
      bitCount -= 5;
      chars[outIdx++] = CROCKFORD_LOWER[(bitBuffer >>> bitCount) & 0x1f];
    }
  }
  return chars.join('');
}

const SHORT_ID_PREFIXES = new Set<IdPrefix>(['prj', 'pub', 'run']);

export function createId(prefix: IdPrefix, nowMs?: number): string {
  if (SHORT_ID_PREFIXES.has(prefix)) {
    return `${prefix}-${generateShortId(8)}`;
  }
  return `${prefix}-${generateUlid(nowMs)}`;
}

const DNS_LABEL_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// Accept both simplified 8-char Crockford IDs and legacy 26-char ULIDs
const PREFIXED_ID_REGEX = /^(prj|pub|run|dat|usr|grp|rev|job|tok|ses)-[0-9a-hjkmnp-tv-z]{8,26}$/;

export function isValidDnsLabel(label: string): boolean {
  return DNS_LABEL_REGEX.test(label);
}

export function isValidPrefixedId(id: string, expectedPrefix?: IdPrefix): boolean {
  if (!PREFIXED_ID_REGEX.test(id)) return false;
  if (expectedPrefix && !id.startsWith(`${expectedPrefix}-`)) return false;
  return isValidDnsLabel(id);
}

export function slugify(raw: string, maxLen = 48): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '');
  return cleaned || 'project';
}
