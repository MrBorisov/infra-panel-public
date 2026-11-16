import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { resolveTarget, type Target } from './netguard.js';

export interface ProbeResult {
  ok: boolean;
  latencyMs: number | null;
  message: string | null;
  httpStatus?: number | null;
}

const errorText = (e: unknown) => {
  if (e instanceof Error) {
    const cause = (e as Error & { cause?: { code?: string; message?: string } }).cause;
    if (cause?.code) return `${cause.code}${cause.message ? `: ${cause.message}` : ''}`;
    return e.message;
  }
  return String(e);
};

/** Сервер жив, если принимает TCP-соединение на порту (по умолчанию 22, SSH) */
export async function tcpProbe(host: string, port: number, timeoutMs = 5000): Promise<ProbeResult> {
  let target: Target;
  try {
    target = await resolveTarget(host);
  } catch (e) {
    return { ok: false, latencyMs: null, message: errorText(e) };
  }
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = net.connect({ host: target.address, port });
    const done = (result: ProbeResult) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done({ ok: true, latencyMs: Math.round(performance.now() - started), message: null }));
    socket.once('timeout', () => done({ ok: false, latencyMs: null, message: `Нет ответа на порту ${port} за ${timeoutMs / 1000} с` }));
    socket.once('error', (e) => done({ ok: false, latencyMs: null, message: errorText(e) }));
  });
}

const MAX_REDIRECTS = 5;
// Ключевое слово ищем в первом мегабайте: гигабайтный ответ не должен ронять панель
const MAX_BODY = 1024 * 1024;

interface HttpAnswer {
  status: number;
  location: string | null;
  body: string;
}

/** Один запрос без автоматических редиректов — к адресу, проверенному resolveTarget */
async function httpGet(url: URL, readBody: boolean, timeoutMs: number): Promise<HttpAnswer> {
  const target = await resolveTarget(url.hostname);
  const secure = url.protocol === 'https:';
  const name = url.hostname.replace(/^\[(.*)\]$/, '$1');
  let timer: NodeJS.Timeout | undefined;
  return new Promise<HttpAnswer>((resolve, reject) => {
    const req = (secure ? https : http).request(
      {
        host: target.address,
        family: target.family,
        port: url.port || (secure ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        // Сертификат сверяется с именем сайта, а не с IP, к которому подключились
        ...(secure && !net.isIP(name) ? { servername: name } : {}),
        headers: { host: url.host, 'user-agent': 'InfraPanel-Monitor/1.0', accept: 'text/html,*/*', 'accept-encoding': 'identity' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === 'string' ? res.headers.location : null;
        if (!readBody || (status >= 300 && status < 400)) {
          res.destroy();
          return resolve({ status, location, body: '' });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const finish = () => resolve({ status, location, body: Buffer.concat(chunks).toString('utf8') });
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          size += chunk.length;
          if (size >= MAX_BODY) {
            res.destroy();
            finish();
          }
        });
        res.on('end', finish);
        res.on('error', reject);
      },
    );
    // Общий срок на весь запрос, а не на простой: сайт, отдающий по байту, иначе держал бы место проверки часами
    timer = setTimeout(() => {
      reject(Object.assign(new Error('timeout'), { name: 'TimeoutError' }));
      req.destroy();
    }, timeoutMs);
    req.on('error', reject);
    req.end();
  }).finally(() => clearTimeout(timer));
}

/** Сайт работает, если отвечает кодом < 400 и (опционально) содержит ключевое слово */
export async function httpProbe(url: string, keyword: string | null, timeoutMs = 15000): Promise<ProbeResult> {
  const started = performance.now();
  const fail = (message: string, httpStatus: number | null = null): ProbeResult => ({ ok: false, latencyMs: null, httpStatus, message });
  try {
    let current = new URL(url);
    for (let hop = 0; ; hop++) {
      const left = timeoutMs - (performance.now() - started);
      if (left <= 0) return fail(`Нет ответа за ${timeoutMs / 1000} с`);
      const res = await httpGet(current, !!keyword, left);
      if (res.status >= 300 && res.status < 400 && res.location) {
        // Каждый шаг перенаправления проверяется заново: внешний сайт мог отправить на внутренний адрес
        if (hop >= MAX_REDIRECTS) return fail(`Больше ${MAX_REDIRECTS} перенаправлений`, res.status);
        current = new URL(res.location, current);
        if (current.protocol !== 'http:' && current.protocol !== 'https:') return fail('Перенаправление не на http(s)', res.status);
        continue;
      }
      const latencyMs = Math.round(performance.now() - started);
      if (res.status >= 400) return { ok: false, latencyMs, httpStatus: res.status, message: `HTTP ${res.status}` };
      if (keyword && !res.body.includes(keyword)) {
        return { ok: false, latencyMs, httpStatus: res.status, message: `На странице нет текста «${keyword}»` };
      }
      return { ok: true, latencyMs, httpStatus: res.status, message: null };
    }
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'TimeoutError';
    return fail(timedOut ? `Нет ответа за ${timeoutMs / 1000} с` : errorText(e));
  }
}

interface SslInfo {
  validTo: number;
  issuer: string | null;
  error: string | null;
}

/** Срок действия сертификата берём прямо из TLS-рукопожатия */
export async function sslProbe(host: string, port = 443, timeoutMs = 10000): Promise<SslInfo> {
  const target = await resolveTarget(host);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: target.address, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false });
    socket.setTimeout(timeoutMs);
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      socket.end();
      if (!cert?.valid_to) return reject(new Error('Сервер не отдал сертификат'));
      const issuer = cert.issuer ? (cert.issuer.O ?? cert.issuer.CN ?? null) : null;
      resolve({
        validTo: new Date(cert.valid_to).getTime(),
        issuer: Array.isArray(issuer) ? issuer[0] : issuer,
        error: socket.authorized ? null : String(socket.authorizationError ?? 'Сертификат не прошёл проверку'),
      });
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('Таймаут TLS-соединения'));
    });
    socket.once('error', (e) => reject(e));
  });
}
