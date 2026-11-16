import { Resolver } from 'node:dns/promises';
import net from 'node:net';
import os from 'node:os';
import { config } from '../config.js';

/**
 * Куда проверки мониторинга не ходят. Серверы и сайты заводят пользователи панели, в том числе
 * посторонние, а проверки идут с нашего сервера, где рядом могут работать другие сервисы. Без запрета
 * сайт `http://127.0.0.1:8001/…` с ключевым словом читал бы внутренние страницы по символу,
 * а серверы `127.0.0.1:<порт>` давали бы карту портов.
 */
const blocked = new net.BlockList();
const V4: [string, number][] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local и метаданные облака
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];
const V6: [string, number][] = [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7], // ULA
  ['fe80::', 10],
  ['ff00::', 8],
];
// IPv4 внутри IPv6 (::ffff:127.0.0.1) BlockList сам сверяет с правилами IPv4. Правило
// ::ffff:0:0/96 ставить нельзя: BlockList применяет его ко ВСЕМ адресам IPv4 — так 08.10.2026
// мониторинг счёл внутренними все серверы и сайты
for (const [a, p] of V4) blocked.addSubnet(a, p, 'ipv4');
for (const [a, p] of V6) blocked.addSubnet(a, p, 'ipv6');
// Свои адреса сервера, включая публичный: на него отвечает тот же nginx
for (const list of Object.values(os.networkInterfaces())) {
  for (const i of list ?? []) blocked.addAddress(i.address.split('%')[0], i.family === 'IPv6' ? 'ipv6' : 'ipv4');
}

export function isForbiddenAddress(ip: string) {
  if (config.monitor.allowPrivate) return false;
  return blocked.check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4');
}

export interface Target {
  address: string;
  family: 4 | 6;
}

// Адреса ищем запросом в DNS со своим сроком, а не через lookup: тот на всё ожидание системного
// резолвера занимает один из 4 потоков libuv, где считается и scrypt входа, — и молчащий DNS
// чужих доменов вешал бы вход в панель. /etc/hosts он не читает, поэтому localhost — явно
export const resolver = new Resolver({ timeout: 2000, tries: 2 });

export async function resolveAll(name: string): Promise<Target[]> {
  const [v4, v6] = await Promise.allSettled([resolver.resolve4(name), resolver.resolve6(name)]);
  const pick = (r: PromiseSettledResult<string[]>, family: 4 | 6) => (r.status === 'fulfilled' ? r.value.map((address) => ({ address, family })) : []);
  return [...pick(v4, 4), ...pick(v6, 6)];
}

/**
 * Адрес для подключения: имя резолвим сами, запрещённые отбрасываем и подключаемся ровно к
 * проверенному IP. Если резолвить второй раз при подключении, DNS с коротким TTL подсунул бы
 * уже внутренний адрес (DNS rebinding).
 */
export async function resolveTarget(host: string): Promise<Target> {
  const name = host.replace(/^\[(.*)\]$/, '$1');
  const family = net.isIP(name);
  if (!family && /(^|\.)localhost\.?$/i.test(name) && !config.monitor.allowPrivate) {
    throw new Error(`${host} — внутренний адрес, проверять его с сервера панели нельзя`);
  }
  const list: Target[] = family ? [{ address: name, family: family as 4 | 6 }] : await resolveAll(name);
  if (!list.length) throw new Error(`Не удалось найти адрес ${host}`);
  // Хоть один внутренний адрес — отказ целиком: иначе выбор адреса отдан резолверу
  if (list.some((a) => isForbiddenAddress(a.address))) {
    throw new Error(`${host} — внутренний адрес, проверять его с сервера панели нельзя`);
  }
  return list[0];
}
