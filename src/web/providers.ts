/** Популярные провайдеры: при выборе подставляется ссылка на личный кабинет */
export const providerPresets: { name: string; url: string }[] = [
  { name: 'Hetzner', url: 'https://console.hetzner.cloud' },
  { name: 'Timeweb Cloud', url: 'https://timeweb.cloud/my' },
  { name: 'Timeweb', url: 'https://hosting.timeweb.ru' },
  { name: 'Selectel', url: 'https://my.selectel.ru' },
  { name: 'Beget', url: 'https://cp.beget.com' },
  { name: 'REG.RU', url: 'https://www.reg.ru/user/account' },
  { name: 'RU-CENTER', url: 'https://www.nic.ru/manager/' },
  { name: 'Cloudflare', url: 'https://dash.cloudflare.com' },
  { name: 'Yandex Cloud', url: 'https://console.yandex.cloud' },
  { name: 'VK Cloud', url: 'https://msk.cloud.vk.com' },
  { name: 'FirstVDS', url: 'https://my.firstvds.ru' },
  { name: 'Aeza', url: 'https://my.aeza.net' },
  { name: 'Sprinthost', url: 'https://cp.sprinthost.ru' },
  { name: 'SpaceWeb', url: 'https://cp.sweb.ru' },
  { name: 'DigitalOcean', url: 'https://cloud.digitalocean.com' },
  { name: 'Vultr', url: 'https://my.vultr.com' },
  { name: 'Contabo', url: 'https://my.contabo.com' },
  { name: 'OVHcloud', url: 'https://www.ovh.com/manager/' },
  { name: 'Linode', url: 'https://cloud.linode.com' },
  { name: 'AWS', url: 'https://console.aws.amazon.com' },
  { name: 'Google Cloud', url: 'https://console.cloud.google.com' },
  { name: 'Hostinger', url: 'https://hpanel.hostinger.com' },
  { name: 'Namecheap', url: 'https://ap.www.namecheap.com' },
  { name: 'GoDaddy', url: 'https://account.godaddy.com' },
  { name: 'Porkbun', url: 'https://porkbun.com/account' },
];

export function findPreset(name: string) {
  const n = name.trim().toLowerCase();
  return providerPresets.find((p) => p.name.toLowerCase() === n);
}

// Зоны, где регистрируют домены третьего уровня (example.com.ru, example.co.uk)
const SECOND_LEVEL = new Set([
  'com.ru', 'net.ru', 'org.ru', 'pp.ru', 'msk.ru', 'spb.ru',
  'co.uk', 'org.uk', 'com.ua', 'kiev.ua', 'com.kz', 'org.kz', 'com.by',
  'com.au', 'co.jp', 'com.br', 'com.tr', 'co.il',
]);

/** Хост из строки, введённой как угодно: «https://www.example.com/path» → «www.example.com» */
export function hostFromInput(raw: string) {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .split(/[/:?#]/)[0]
    .replace(/\.$/, '');
}

/** Домен, который регистрируют у регистратора: «shop.example.com» → «example.com» */
export function registrableDomain(host: string) {
  const labels = host.replace(/^www\./, '').split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const last2 = labels.slice(-2).join('.');
  return SECOND_LEVEL.has(last2) ? labels.slice(-3).join('.') : last2;
}

export function normalizeUrlInput(raw: string) {
  const v = raw.trim();
  if (!v) return v;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`;
}
