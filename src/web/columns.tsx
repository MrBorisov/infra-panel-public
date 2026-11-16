import { ActionIcon, Anchor, Badge, CopyButton, Group, Stack, Text, Tooltip } from '@mantine/core';
import { IconCheck, IconCopy, IconExternalLink, IconRefresh } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { plural } from '../shared/text';
import type { Account, AnyEntity, Domain, EntityPath, Hosting, Server, Site } from '../shared/types';
import { DeadlineBadge, StatusBadge } from './components/badges';
import { serverHost, type Lookups } from './entities';
import { fmtMoney, fromNow } from './format';

interface Column<T extends AnyEntity = AnyEntity> {
  title: string;
  render: (row: T, l: Lookups) => ReactNode;
  w?: number;
}

const stop = (e: React.MouseEvent) => e.stopPropagation();

export function ExternalLink({ href, children }: { href: string | null | undefined; children?: ReactNode }) {
  if (!href) return <>—</>;
  return (
    <Anchor href={href} target="_blank" rel="noreferrer" size="sm" onClick={stop}>
      <Group gap={4} wrap="nowrap" component="span">
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{children ?? href.replace(/^https?:\/\//, '')}</span>
        <IconExternalLink size={12} style={{ flexShrink: 0 }} />
      </Group>
    </Anchor>
  );
}

export function RefLink({ path, entity }: { path: EntityPath; entity?: { id: number; name: string } | null }) {
  if (!entity) return <Text c="dimmed">—</Text>;
  return (
    <Anchor component={Link} to={`/${path}/${entity.id}`} size="sm" onClick={stop}>
      {entity.name}
    </Anchor>
  );
}

export function CopyText({ value }: { value: string | null | undefined }) {
  if (!value) return <Text c="dimmed">—</Text>;
  return (
    <Group gap={4} wrap="nowrap">
      <Text size="sm" className="mono">
        {value}
      </Text>
      <CopyButton value={value} timeout={1500}>
        {({ copied, copy }) => (
          <ActionIcon
            variant="subtle"
            color={copied ? 'teal' : 'gray'}
            size="xs"
            onClick={(e) => {
              stop(e);
              copy();
            }}
            aria-label="Скопировать"
          >
            {copied ? <IconCheck size={12} /> : <IconCopy size={12} />}
          </ActionIcon>
        )}
      </CopyButton>
    </Group>
  );
}

export function Price({ price, currency, period }: { price: number | null; currency: string; period: 'month' | 'year' }) {
  if (price == null) return <Text c="dimmed">—</Text>;
  return (
    <Text size="sm" style={{ whiteSpace: 'nowrap' }}>
      {fmtMoney(price, currency)}
      <Text span c="dimmed" size="xs">
        {period === 'year' ? ' / год' : ' / мес'}
      </Text>
    </Text>
  );
}

const statusCol: Column<Server | Site> = {
  title: 'Статус',
  w: 130,
  render: (s) => <StatusBadge status={s.status} monitorEnabled={s.monitorEnabled} lastCheckAt={s.lastCheckAt} error={s.lastError} />,
};

const nameCol = <T extends AnyEntity>(sub?: (r: T) => ReactNode): Column<T> => ({
  title: 'Название',
  render: (r) => (
    <Stack gap={0}>
      <Text fw={500} size="sm">
        {r.name}
      </Text>
      {sub && (
        <Text size="xs" c="dimmed" lineClamp={1}>
          {sub(r)}
        </Text>
      )}
    </Stack>
  ),
});

const priceCol: Column<Server | Domain | Hosting> = {
  title: 'Стоимость',
  render: (r) => <Price price={r.price} currency={r.currency} period={r.billingPeriod} />,
};

const count = (n: number, forms: [string, string, string]) => (n ? `${n} ${plural(n, forms)}` : null);

// Таблица раздела показывает только его объекты, поэтому колонки пишутся под свой тип с одним приведением на раздел
const cols = <T extends AnyEntity>(list: Column<T>[]) => list as unknown as Column[];

export const listColumns: Record<EntityPath, Column[]> = {
  servers: cols<Server>([
    statusCol,
    nameCol((r) => r.description),
    { title: 'Адрес', render: (r) => <CopyText value={serverHost(r)} /> },
    { title: 'Аккаунт', render: (r, l) => <RefLink path="accounts" entity={l.accounts.get(r.accountId ?? 0)} /> },
    { title: 'ОС', render: (r) => r.os ?? '—' },
    { title: 'Оплачен до', render: (r) => <DeadlineBadge date={r.paidUntil} /> },
    priceCol,
  ]),
  sites: cols<Site>([
    statusCol,
    nameCol((r) => r.stack),
    { title: 'Адрес', render: (r) => <ExternalLink href={r.url} /> },
    {
      title: 'Размещение',
      render: (s, l) => {
        const server = l.servers.get(s.serverId ?? 0);
        const hosting = l.hostings.get(s.hostingId ?? 0);
        if (server) return <RefLink path="servers" entity={server} />;
        if (hosting) return <RefLink path="hostings" entity={hosting} />;
        return <Text c="dimmed">—</Text>;
      },
    },
    { title: 'Домен', render: (r, l) => <RefLink path="domains" entity={l.domains.get(r.domainId ?? 0)} /> },
    { title: 'SSL', render: (r) => (r.sslExpiresAt ? <DeadlineBadge date={r.sslExpiresAt} withDate={false} /> : '—') },
    { title: 'Отклик', render: (r) => (r.lastLatencyMs != null ? `${r.lastLatencyMs} мс` : '—') },
  ]),
  domains: cols<Domain>([
    { ...nameCol(), title: 'Домен' },
    { title: 'Регистратор', render: (r, l) => <RefLink path="accounts" entity={l.accounts.get(r.registrarAccountId ?? 0)} /> },
    { title: 'DNS', render: (r, l) => <RefLink path="accounts" entity={l.accounts.get(r.dnsAccountId ?? 0)} /> },
    {
      title: 'Оплачен до',
      render: (d) => (
        <Group gap={6} wrap="nowrap">
          <DeadlineBadge date={d.expiresAt} />
          {d.autoRenew && (
            <Tooltip label="Автопродление включено">
              <IconRefresh size={14} color="var(--mantine-color-teal-6)" />
            </Tooltip>
          )}
          {d.lastLookupError && (
            <Tooltip label={d.lastLookupError} multiline maw={300}>
              <Badge color="yellow" variant="light" size="xs">
                ошибка проверки
              </Badge>
            </Tooltip>
          )}
        </Group>
      ),
    },
    priceCol,
  ]),
  hostings: cols<Hosting>([
    nameCol((r) => r.plan),
    { title: 'Аккаунт', render: (r, l) => <RefLink path="accounts" entity={l.accounts.get(r.accountId ?? 0)} /> },
    { title: 'Сайтов', render: (r, l) => l.lists.sites.filter((s) => s.hostingId === r.id).length || '—' },
    { title: 'Оплачен до', render: (r) => <DeadlineBadge date={r.paidUntil} /> },
    priceCol,
  ]),
  accounts: cols<Account>([
    nameCol((r) => r.provider),
    { title: 'Личный кабинет', render: (r) => <ExternalLink href={r.url} /> },
    {
      title: 'Объекты',
      render: (r, l) => {
        const parts = [
          count(l.lists.servers.filter((s) => s.accountId === r.id).length, ['сервер', 'сервера', 'серверов']),
          count(l.lists.hostings.filter((s) => s.accountId === r.id).length, ['хостинг', 'хостинга', 'хостингов']),
          count(l.lists.domains.filter((d) => d.registrarAccountId === r.id || d.dnsAccountId === r.id).length, ['домен', 'домена', 'доменов']),
        ].filter(Boolean);
        return parts.length ? parts.join(' · ') : <Text c="dimmed">—</Text>;
      },
    },
    { title: 'Изменён', render: (r) => fromNow(r.updatedAt) },
  ]),
};

export function searchText(row: AnyEntity) {
  const r = row as unknown as Record<string, unknown>;
  return ['name', 'description', 'ip', 'hostname', 'url', 'provider', 'stack', 'plan', 'os', 'notes']
    .map((k) => r[k])
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}
