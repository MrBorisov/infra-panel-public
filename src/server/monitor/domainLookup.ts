import net from 'node:net';
import { domainToASCII } from 'node:url';

interface DomainExpiry {
  expiresAt: string; // YYYY-MM-DD
  source: 'rdap' | 'whois';
}

const DAY = 86_400_000;
let rdapBootstrap: { fetchedAt: number; map: Map<string, string> } | null = null;

// У .ru/.su/.рф нет RDAP, только WHOIS Координационного центра
const KNOWN_WHOIS: Record<string, string> = {
  ru: 'whois.tcinet.ru',
  su: 'whois.tcinet.ru',
  'xn--p1ai': 'whois.tcinet.ru',
};

async function rdapBaseFor(tld: string): Promise<string | undefined> {
  if (!rdapBootstrap || Date.now() - rdapBootstrap.fetchedAt > DAY) {
    const res = await fetch('https://data.iana.org/rdap/dns.json', { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`IANA RDAP bootstrap: HTTP ${res.status}`);
    const json = (await res.json()) as { services: [string[], string[]][] };
    const map = new Map<string, string>();
    for (const [tlds, urls] of json.services) {
      const url = urls.find((u) => u.startsWith('https://')) ?? urls[0];
      for (const t of tlds) map.set(t.toLowerCase(), url);
    }
    rdapBootstrap = { fetchedAt: Date.now(), map };
  }
  return rdapBootstrap.map.get(tld);
}

async function rdapLookup(domain: string, base: string): Promise<string> {
  const url = `${base.replace(/\/?$/, '/')}domain/${domain}`;
  const res = await fetch(url, {
    headers: { accept: 'application/rdap+json, application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 404) throw new Error('Домен не найден в RDAP (проверьте, что это домен второго уровня)');
  if (!res.ok) throw new Error(`RDAP: HTTP ${res.status}`);
  const json = (await res.json()) as { events?: { eventAction: string; eventDate: string }[] };
  const expiration = json.events?.find((e) => e.eventAction === 'expiration');
  if (!expiration) throw new Error('RDAP не вернул дату окончания');
  return expiration.eventDate;
}

function whoisQuery(server: string, query: string, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: server, port: 43 });
    const chunks: Buffer[] = [];
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => socket.write(`${query}\r\n`));
    socket.on('data', (c) => chunks.push(Buffer.from(c)));
    socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`WHOIS ${server}: таймаут`));
    });
    socket.once('error', reject);
  });
}

const WHOIS_EXPIRY_PATTERNS = [
  /paid-till:\s*(\S+)/i,
  /Registry Expiry Date:\s*(\S+)/i,
  /Registrar Registration Expiration Date:\s*(\S+)/i,
  /Expir(?:y|ation) Date:\s*(\S+)/i,
  /expires(?: on)?:\s*(\S+)/i,
];

async function whoisLookup(domain: string, tld: string): Promise<string> {
  let server = KNOWN_WHOIS[tld];
  if (!server) {
    const iana = await whoisQuery('whois.iana.org', tld);
    server = iana.match(/^whois:\s*(\S+)/m)?.[1] ?? '';
    if (!server) throw new Error(`Не найден WHOIS-сервер для .${tld}`);
  }
  const text = await whoisQuery(server, domain);
  if (/no entries found|not found|no match/i.test(text)) throw new Error('Домен не найден в WHOIS');
  for (const re of WHOIS_EXPIRY_PATTERNS) {
    const m = text.match(re);
    if (m) return m[1];
  }
  throw new Error('В ответе WHOIS нет даты окончания');
}

function toDateString(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`Не удалось разобрать дату «${value}»`);
  return d.toISOString().slice(0, 10);
}

export async function lookupDomainExpiry(name: string): Promise<DomainExpiry> {
  const domain = domainToASCII(name);
  if (!domain) throw new Error('Некорректное имя домена');
  const tld = domain.split('.').pop()!;

  if (!KNOWN_WHOIS[tld]) {
    const base = await rdapBaseFor(tld).catch(() => undefined);
    if (base) {
      try {
        return { expiresAt: toDateString(await rdapLookup(domain, base)), source: 'rdap' };
      } catch (e) {
        // Домен не найден — это окончательный ответ, а сетевые ошибки пробуем обойти через WHOIS
        if (e instanceof Error && e.message.startsWith('Домен не найден')) throw e;
      }
    }
  }
  return { expiresAt: toDateString(await whoisLookup(domain, tld)), source: 'whois' };
}
