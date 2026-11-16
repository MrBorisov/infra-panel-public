import { IconBuildingStore, IconCloud, IconServer, IconWorld, IconWorldWww, type Icon } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { Account, AnyEntity, CredentialKind, Domain, EntityPath, EntityType, Hosting, Server, Site } from '../shared/types';
import { api } from './api';

type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'date'
  | 'switch'
  | 'ref' // выбор связанного объекта, с созданием нового на лету
  | 'money' // стоимость + валюта + период (поля price, currency, billingPeriod)
  | 'placement' // где размещён сайт: сервер или хостинг (поля serverId, hostingId)
  | 'provider'; // провайдер с подсказками и автоподстановкой ссылки на ЛК

export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  ref?: EntityPath;
  placeholder?: string;
  description?: string;
  full?: boolean;
  defaultValue?: unknown;
}

interface FormSection {
  title?: string;
  fields: FieldDef[];
}

export interface EntityConfig {
  path: EntityPath;
  type: EntityType;
  title: string;
  single: string;
  accusative: string;
  icon: Icon;
  sections: FormSection[];
  fields: FieldDef[];
  monitor?: 'server' | 'site';
  defaultCredentialKind: CredentialKind;
  related?: { path: EntityPath; fk: string; title: string }[];
}

export const currencyOptions = ['RUB', 'USD', 'EUR'].map((c) => ({ value: c, label: c }));
export const periodOptions = [
  { value: 'month', label: 'в месяц' },
  { value: 'year', label: 'в год' },
];

const money = (defaultPeriod: 'month' | 'year'): FieldDef => ({ name: 'price', label: 'Стоимость', type: 'money', defaultValue: defaultPeriod });
const notes: FormSection = { fields: [{ name: 'notes', label: 'Заметки', type: 'textarea', full: true }] };

function config(c: Omit<EntityConfig, 'fields'>): EntityConfig {
  return { ...c, fields: c.sections.flatMap((s) => s.fields) };
}

export const entityConfigs: Record<EntityPath, EntityConfig> = {
  servers: config({
    path: 'servers',
    type: 'server',
    title: 'Серверы',
    single: 'Сервер',
    accusative: 'сервер',
    icon: IconServer,
    monitor: 'server',
    defaultCredentialKind: 'ssh',
    related: [{ path: 'sites', fk: 'serverId', title: 'Сайты на сервере' }],
    sections: [
      {
        fields: [
          { name: 'name', label: 'Название', type: 'text', required: true, placeholder: 'web-1' },
          { name: 'accountId', label: 'Аккаунт хостера', type: 'ref', ref: 'accounts', placeholder: 'Выберите или введите новый' },
          { name: 'hostname', label: 'Hostname', type: 'text', placeholder: 'web-1.example.com' },
          { name: 'ip', label: 'IP-адрес', type: 'text', placeholder: '203.0.113.10' },
          { name: 'description', label: 'Описание', type: 'textarea', full: true, placeholder: 'Для чего этот сервер' },
        ],
      },
      {
        title: 'Конфигурация',
        fields: [
          { name: 'os', label: 'ОС', type: 'text', placeholder: 'Ubuntu 24.04' },
          { name: 'location', label: 'Локация', type: 'text', placeholder: 'Хельсинки' },
          { name: 'plan', label: 'Тариф', type: 'text', full: true, placeholder: '2 vCPU · 4 GB · 40 GB' },
        ],
      },
      {
        title: 'Оплата',
        fields: [money('month'), { name: 'paidUntil', label: 'Оплачен до', type: 'date' }],
      },
      {
        title: 'Мониторинг',
        fields: [
          { name: 'monitorEnabled', label: 'Следить за доступностью', type: 'switch', defaultValue: true },
          {
            name: 'monitorPort',
            label: 'Порт для проверки',
            type: 'number',
            defaultValue: 22,
            description: 'Обычно 22 (SSH). Если SSH закрыт снаружи — 80 или 443',
          },
        ],
      },
      notes,
    ],
  }),
  sites: config({
    path: 'sites',
    type: 'site',
    title: 'Сайты',
    single: 'Сайт',
    accusative: 'сайт',
    icon: IconWorld,
    monitor: 'site',
    defaultCredentialKind: 'admin',
    sections: [
      {
        fields: [
          {
            name: 'url',
            label: 'Адрес сайта',
            type: 'text',
            required: true,
            full: true,
            placeholder: 'example.com',
            description: 'Название, домен и сервер подставятся сами',
          },
          { name: 'name', label: 'Название', type: 'text', required: true, placeholder: 'Интернет-магазин' },
          { name: 'domainId', label: 'Домен', type: 'ref', ref: 'domains', placeholder: 'Выберите или введите новый' },
          { name: 'stack', label: 'CMS / стек', type: 'text', placeholder: 'WordPress, Laravel, Next.js…' },
          { name: 'path', label: 'Путь на сервере', type: 'text', placeholder: '/var/www/example' },
        ],
      },
      { title: 'Где размещён', fields: [{ name: 'placement', label: 'Размещение', type: 'placement', full: true }] },
      {
        title: 'Мониторинг',
        fields: [
          { name: 'monitorEnabled', label: 'Следить за доступностью', type: 'switch', defaultValue: true },
          {
            name: 'keyword',
            label: 'Проверочный текст',
            type: 'text',
            description: 'Сайт считается рабочим, только если этот текст есть на странице',
          },
        ],
      },
      notes,
    ],
  }),
  domains: config({
    path: 'domains',
    type: 'domain',
    title: 'Домены',
    single: 'Домен',
    accusative: 'домен',
    icon: IconWorldWww,
    defaultCredentialKind: 'panel',
    related: [{ path: 'sites', fk: 'domainId', title: 'Сайты на домене' }],
    sections: [
      {
        fields: [
          { name: 'name', label: 'Домен', type: 'text', required: true, full: true, placeholder: 'example.com' },
          { name: 'registrarAccountId', label: 'Регистратор', type: 'ref', ref: 'accounts', placeholder: 'Выберите или введите новый' },
          {
            name: 'dnsAccountId',
            label: 'DNS',
            type: 'ref',
            ref: 'accounts',
            placeholder: 'Если не у регистратора',
            description: 'Где управляются DNS-записи, например Cloudflare',
          },
        ],
      },
      {
        title: 'Срок и оплата',
        fields: [
          { name: 'autoLookup', label: 'Узнавать срок через RDAP/WHOIS', type: 'switch', defaultValue: true },
          { name: 'autoRenew', label: 'Автопродление у регистратора', type: 'switch', defaultValue: false },
          { name: 'expiresAt', label: 'Оплачен до', type: 'date', description: 'Заполнится сам, если включена проверка срока' },
          money('year'),
        ],
      },
      notes,
    ],
  }),
  hostings: config({
    path: 'hostings',
    type: 'hosting',
    title: 'Хостинг',
    single: 'Хостинг',
    accusative: 'хостинг',
    icon: IconCloud,
    defaultCredentialKind: 'panel',
    related: [{ path: 'sites', fk: 'hostingId', title: 'Сайты на хостинге' }],
    sections: [
      {
        fields: [
          { name: 'name', label: 'Название', type: 'text', required: true, placeholder: 'Beget — основной' },
          { name: 'accountId', label: 'Аккаунт провайдера', type: 'ref', ref: 'accounts', placeholder: 'Выберите или введите новый' },
          { name: 'plan', label: 'Тариф', type: 'text', full: true },
        ],
      },
      { title: 'Оплата', fields: [money('month'), { name: 'paidUntil', label: 'Оплачен до', type: 'date' }] },
      notes,
    ],
  }),
  accounts: config({
    path: 'accounts',
    type: 'account',
    title: 'Аккаунты',
    single: 'Аккаунт',
    accusative: 'аккаунт',
    icon: IconBuildingStore,
    defaultCredentialKind: 'panel',
    related: [
      { path: 'servers', fk: 'accountId', title: 'Серверы' },
      { path: 'hostings', fk: 'accountId', title: 'Хостинг' },
      { path: 'domains', fk: 'registrarAccountId', title: 'Домены (регистратор)' },
      { path: 'domains', fk: 'dnsAccountId', title: 'Домены (DNS)' },
    ],
    sections: [
      {
        fields: [
          {
            name: 'provider',
            label: 'Провайдер',
            type: 'provider',
            placeholder: 'Начните вводить: Hetzner, Beget, REG.RU…',
          },
          { name: 'name', label: 'Название', type: 'text', required: true, placeholder: 'Hetzner — основной' },
          { name: 'url', label: 'Ссылка на личный кабинет', type: 'text', full: true, placeholder: 'https://console.hetzner.cloud' },
        ],
      },
      notes,
    ],
  }),
};

export const navOrder: EntityPath[] = ['servers', 'sites', 'domains', 'hostings', 'accounts'];

export const configByType: Record<string, EntityConfig> = Object.fromEntries(Object.values(entityConfigs).map((c) => [c.type, c]));

/** Адрес сервера: IP, а если его нет — hostname */
export const serverHost = (s?: Server) => (s ? s.ip || s.hostname : null);

export interface Lookups {
  accounts: Map<number, Account>;
  servers: Map<number, Server>;
  hostings: Map<number, Hosting>;
  domains: Map<number, Domain>;
  lists: { accounts: Account[]; servers: Server[]; hostings: Hosting[]; domains: Domain[]; sites: Site[] };
  isPending: boolean;
}

function useEntityList<T extends AnyEntity>(path: EntityPath) {
  return useQuery({
    queryKey: [path],
    queryFn: () => api.get<T[]>(`/api/${path}`),
    // Статусы и сроки доменов обновляются в фоне, поэтому эти списки периодически перечитываем
    refetchInterval: path === 'servers' || path === 'sites' ? 30_000 : path === 'domains' ? 60_000 : false,
  });
}

/** Все списки сразу: данных немного, а связи удобно разрешать на клиенте */
export function useLookups(): Lookups {
  const accounts = useEntityList<Account>('accounts');
  const servers = useEntityList<Server>('servers');
  const hostings = useEntityList<Hosting>('hostings');
  const domains = useEntityList<Domain>('domains');
  const sites = useEntityList<Site>('sites');
  const map = <T extends { id: number }>(list?: T[]) => new Map((list ?? []).map((x) => [x.id, x]));
  return {
    accounts: map(accounts.data),
    servers: map(servers.data),
    hostings: map(hostings.data),
    domains: map(domains.data),
    lists: {
      accounts: accounts.data ?? [],
      servers: servers.data ?? [],
      hostings: hostings.data ?? [],
      domains: domains.data ?? [],
      sites: sites.data ?? [],
    },
    isPending: [accounts, servers, hostings, domains, sites].some((q) => q.isPending),
  };
}
