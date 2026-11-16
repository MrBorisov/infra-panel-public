import { ActionIcon, Anchor, Badge, Button, Card, Grid, Group, Menu, Stack, Table, Text, Title, Tooltip } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import {
  IconArrowLeft,
  IconCalendarCheck,
  IconDots,
  IconPencil,
  IconPlayerPlay,
  IconPlus,
  IconSearch,
  IconTrash,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import type { Account, AnyEntity, Domain, EntityPath, Hosting, Server, Site } from '../../shared/types';
import { api } from '../api';
import { useAuth } from '../auth';
import { CopyText, ExternalLink, Price, RefLink } from '../columns';
import { DeadlineBadge, StatusBadge } from '../components/badges';
import { CredentialsCard } from '../components/Credentials';
import { MonitorPanel } from '../components/MonitorPanel';
import { NotFound, PageLoader } from '../components/PageState';
import { EntityDrawer, useCreate } from '../create';
import { entityConfigs, serverHost, useLookups, type Lookups } from '../entities';
import { fmtDate, fmtDateTime, fromNow, nextPaymentDate } from '../format';

type InfoRow = [string, ReactNode] | null | false;

const notesRow = (notes: string | null): InfoRow =>
  !!notes && [
    'Заметки',
    <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>
      {notes}
    </Text>,
  ];

/** Аккаунт со ссылкой на карточку и прямой ссылкой в личный кабинет */
function AccountRef({ account }: { account?: Account }) {
  if (!account) return <Text c="dimmed">—</Text>;
  return (
    <Group gap="sm" wrap="nowrap">
      <RefLink path="accounts" entity={account} />
      {account.url && <ExternalLink href={account.url}>ЛК</ExternalLink>}
    </Group>
  );
}

/** Предзаполнение формы при добавлении связанного объекта из карточки */
function relatedPrefill(path: EntityPath, entity: AnyEntity, fk: string): Record<string, unknown> {
  const prefill: Record<string, unknown> = { [fk]: entity.id };
  if (path === 'domains') Object.assign(prefill, { url: `https://${entity.name}`, name: entity.name });
  return prefill;
}

const sourceLabels: Record<string, string> = { rdap: 'по данным RDAP', whois: 'по данным WHOIS', manual: 'указан вручную' };

/** Состояние автоматической проверки: описание и последняя ошибка либо «выключено» */
function CheckState({ on, off, error, children }: { on: boolean; off: string; error: string | null; children: ReactNode }) {
  if (!on) return <Text c="dimmed" size="sm">{off}</Text>;
  return (
    <Text size="sm">
      {children}
      {error && (
        <Text span c="red" size="sm" display="block">
          {error}
        </Text>
      )}
    </Text>
  );
}

function infoRows(path: EntityPath, e: AnyEntity, l: Lookups): InfoRow[] {
  switch (path) {
    case 'servers': {
      const s = e as Server;
      return [
        !!s.description && ['Описание', <Text size="sm" style={{ whiteSpace: 'pre-wrap' }}>{s.description}</Text>],
        ['IP-адрес', <CopyText value={s.ip} />],
        !!s.hostname && ['Hostname', <CopyText value={s.hostname} />],
        ['Аккаунт', <AccountRef account={l.accounts.get(s.accountId ?? 0)} />],
        !!s.os && ['ОС', s.os],
        !!s.location && ['Локация', s.location],
        !!s.plan && ['Тариф', s.plan],
        ['Стоимость', <Price price={s.price} currency={s.currency} period={s.billingPeriod} />],
        ['Оплачен до', <DeadlineBadge date={s.paidUntil} />],
        [
          'Мониторинг',
          <CheckState on={s.monitorEnabled} off="выключен" error={s.lastError}>
            TCP-порт {s.monitorPort} · проверено {fromNow(s.lastCheckAt)}
            {s.lastLatencyMs != null && ` · ${s.lastLatencyMs} мс`}
          </CheckState>,
        ],
        notesRow(s.notes),
      ];
    }
    case 'sites': {
      const s = e as Site;
      const server = l.servers.get(s.serverId ?? 0);
      const hosting = l.hostings.get(s.hostingId ?? 0);
      return [
        ['Адрес', <ExternalLink href={s.url}>{s.url}</ExternalLink>],
        ['Домен', <RefLink path="domains" entity={l.domains.get(s.domainId ?? 0)} />],
        [
          'Размещение',
          server || hosting ? (
            <Group gap="sm">
              {server && <RefLink path="servers" entity={server} />}
              {server && <Text size="xs" c="dimmed" className="mono">{serverHost(server)}</Text>}
              {hosting && <RefLink path="hostings" entity={hosting} />}
            </Group>
          ) : (
            <Text c="dimmed">—</Text>
          ),
        ],
        !!s.stack && ['CMS / стек', s.stack],
        !!s.path && ['Путь на сервере', <CopyText value={s.path} />],
        [
          'Мониторинг',
          <CheckState on={s.monitorEnabled} off="выключен" error={s.lastError}>
            {s.lastHttpStatus ? `HTTP ${s.lastHttpStatus}` : 'нет ответа'} · проверено {fromNow(s.lastCheckAt)}
            {s.lastLatencyMs != null && ` · ${s.lastLatencyMs} мс`}
          </CheckState>,
        ],
        !!s.keyword && ['Проверочный текст', `«${s.keyword}»`],
        s.url.startsWith('https://') && [
          'SSL-сертификат',
          <Stack gap={2}>
            {s.sslExpiresAt ? <DeadlineBadge date={s.sslExpiresAt} /> : <Text c="dimmed" size="sm">ещё не проверен</Text>}
            {s.sslIssuer && <Text size="xs" c="dimmed">Выдан: {s.sslIssuer}</Text>}
            {s.sslError && <Text size="xs" c="red">{s.sslError}</Text>}
          </Stack>,
        ],
        notesRow(s.notes),
      ];
    }
    case 'domains': {
      const d = e as Domain;
      return [
        ['Регистратор', <AccountRef account={l.accounts.get(d.registrarAccountId ?? 0)} />],
        ['DNS', <AccountRef account={l.accounts.get(d.dnsAccountId ?? 0)} />],
        [
          'Оплачен до',
          <Stack gap={2}>
            <DeadlineBadge date={d.expiresAt} />
            {d.expiresSource && <Text size="xs" c="dimmed">{sourceLabels[d.expiresSource]}</Text>}
          </Stack>,
        ],
        ['Автопродление', d.autoRenew ? <Badge color="teal" variant="light">включено</Badge> : 'нет'],
        [
          'Проверка срока',
          <CheckState on={d.autoLookup} off="выключена" error={d.lastLookupError}>
            автоматически · {d.lastLookupAt ? `проверено ${fromNow(d.lastLookupAt)}` : 'ещё не проверялся'}
          </CheckState>,
        ],
        ['Стоимость', <Price price={d.price} currency={d.currency} period={d.billingPeriod} />],
        notesRow(d.notes),
      ];
    }
    case 'hostings': {
      const h = e as Hosting;
      return [
        ['Аккаунт', <AccountRef account={l.accounts.get(h.accountId ?? 0)} />],
        !!h.plan && ['Тариф', h.plan],
        ['Стоимость', <Price price={h.price} currency={h.currency} period={h.billingPeriod} />],
        ['Оплачен до', <DeadlineBadge date={h.paidUntil} />],
        notesRow(h.notes),
      ];
    }
    case 'accounts': {
      const a = e as Account;
      return [
        !!a.provider && ['Провайдер', a.provider],
        ['Личный кабинет', <ExternalLink href={a.url}>{a.url}</ExternalLink>],
        notesRow(a.notes),
      ];
    }
  }
}

function RelatedCard({
  title,
  path,
  items,
  onAdd,
}: {
  title: string;
  path: EntityPath;
  items: AnyEntity[];
  onAdd?: () => void;
}) {
  if (!items.length && !onAdd) return null;
  return (
    <Card withBorder>
      <Group justify="space-between" mb={items.length ? 'xs' : 0}>
        <Title order={5}>
          {title} <Text span c="dimmed">{items.length || ''}</Text>
        </Title>
        {onAdd && (
          <Tooltip label={`Добавить: ${entityConfigs[path].accusative}`}>
            <ActionIcon variant="light" size="sm" onClick={onAdd} aria-label="Добавить">
              <IconPlus size={14} />
            </ActionIcon>
          </Tooltip>
        )}
      </Group>
      {items.length === 0 && (
        <Text size="sm" c="dimmed">
          Пока нет
        </Text>
      )}
      {items.length > 0 && (
        <Table>
          <Table.Tbody>
            {items.map((it) => {
              const m = it as Partial<Server & Site & Domain>;
              return (
                <Table.Tr key={it.id}>
                  <Table.Td>
                    <Anchor component={Link} to={`/${path}/${it.id}`} size="sm">
                      {it.name}
                    </Anchor>
                  </Table.Td>
                  <Table.Td>
                    {m.status ? (
                      <StatusBadge status={m.status} monitorEnabled={m.monitorEnabled} lastCheckAt={m.lastCheckAt} error={m.lastError} />
                    ) : m.expiresAt !== undefined ? (
                      <DeadlineBadge date={m.expiresAt} />
                    ) : null}
                  </Table.Td>
                </Table.Tr>
              );
            })}
          </Table.Tbody>
        </Table>
      )}
    </Card>
  );
}

export function EntityDetailPage({ path }: { path: EntityPath }) {
  const config = entityConfigs[path];
  const id = Number(useParams().id);
  const { canInfra } = useAuth();
  const { openCreate } = useCreate();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const lookups = useLookups();
  const [editing, setEditing] = useState(false);

  const q = useQuery({
    queryKey: [path, id],
    queryFn: () => api.get<AnyEntity>(`/api/${path}/${id}`),
    refetchInterval: config.monitor ? 30_000 : false,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: [path] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
    if (config.monitor) qc.invalidateQueries({ queryKey: ['monitor', config.monitor, id] });
  };

  const runCheck = useMutation({
    mutationFn: () =>
      path === 'domains' ? api.post(`/api/domains/${id}/lookup`) : api.post(`/api/monitor/${config.monitor}/${id}/run`),
    onSuccess: () => {
      refresh();
      notifications.show({ color: 'teal', message: 'Проверка выполнена' });
    },
    onError: (e) => notifications.show({ color: 'red', message: e.message }),
  });

  const entity = q.data;
  if (q.isPending) return <PageLoader />;
  if (!entity) return <NotFound error={q.error} to={`/${path}`} label="Вернуться к списку" />;

  const billable = entity as Partial<Server & Hosting>;
  const canMarkPaid = (path === 'servers' || path === 'hostings') && canInfra('edit');

  const markPaid = () => {
    const next = nextPaymentDate(billable.paidUntil ?? null, billable.billingPeriod ?? 'month');
    modals.openConfirmModal({
      title: 'Отметить оплату',
      children: (
        <Text size="sm">
          Срок оплаты сдвинется {billable.paidUntil ? `с ${fmtDate(billable.paidUntil)} ` : ''}на <b>{fmtDate(next)}</b>.
        </Text>
      ),
      labels: { confirm: 'Отметить', cancel: 'Отмена' },
      onConfirm: async () => {
        await api.patch(`/api/${path}/${id}`, { paidUntil: next });
        refresh();
      },
    });
  };

  const remove = () =>
    modals.openConfirmModal({
      title: `Удалить «${entity.name}»?`,
      children: <Text size="sm">Вместе с записью удалятся все её доступы. Связанные объекты останутся, но потеряют ссылку на неё.</Text>,
      confirmProps: { color: 'red' },
      labels: { confirm: 'Удалить', cancel: 'Отмена' },
      onConfirm: async () => {
        await api.del(`/api/${path}/${id}`);
        qc.invalidateQueries({ queryKey: [path] });
        qc.invalidateQueries({ queryKey: ['dashboard'] });
        navigate(`/${path}`);
      },
    });

  const monitored = entity as Partial<Server & Site>;
  const rows = infoRows(path, entity, lookups).filter((r): r is [string, ReactNode] => !!r);
  const related = (config.related ?? []).map((r) => ({
    ...r,
    items: lookups.lists[r.path].filter((x) => (x as unknown as Record<string, unknown>)[r.fk] === id),
  }));

  const sshFallback =
    path === 'servers'
      ? serverHost(entity as Server)
      : path === 'sites'
        ? serverHost(lookups.servers.get((entity as Site).serverId ?? 0))
        : null;

  return (
    <Stack>
      <Anchor component={Link} to={`/${path}`} size="sm" c="dimmed">
        <Group gap={4}>
          <IconArrowLeft size={14} /> {config.title}
        </Group>
      </Anchor>

      <Group justify="space-between" align="flex-start">
        <Group gap="sm">
          <Title order={2}>{entity.name}</Title>
          {monitored.status && (
            <StatusBadge
              status={monitored.status}
              monitorEnabled={monitored.monitorEnabled}
              lastCheckAt={monitored.lastCheckAt}
              error={monitored.lastError}
            />
          )}
        </Group>
        {canInfra('edit') && (
          <Group gap="xs">
            {(config.monitor || path === 'domains') && (
              <Button
                variant="default"
                leftSection={path === 'domains' ? <IconSearch size={16} /> : <IconPlayerPlay size={16} />}
                loading={runCheck.isPending}
                onClick={() => runCheck.mutate()}
              >
                {path === 'domains' ? 'Проверить срок' : 'Проверить сейчас'}
              </Button>
            )}
            {canMarkPaid && (
              <Button variant="default" leftSection={<IconCalendarCheck size={16} />} onClick={markPaid}>
                Отметить оплату
              </Button>
            )}
            <Button leftSection={<IconPencil size={16} />} onClick={() => setEditing(true)}>
              Изменить
            </Button>
            <Menu position="bottom-end">
              <Menu.Target>
                <Button variant="default" px="xs" aria-label="Ещё">
                  <IconDots size={16} />
                </Button>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Item color="red" leftSection={<IconTrash size={16} />} onClick={remove}>
                  Удалить
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
          </Group>
        )}
      </Group>

      <Grid>
        <Grid.Col span={{ base: 12, lg: 7 }}>
          <Stack>
            <Card withBorder>
              <Table variant="vertical" layout="fixed" withRowBorders={false} verticalSpacing={6}>
                <Table.Tbody>
                  {rows.map(([label, value]) => (
                    <Table.Tr key={label}>
                      <Table.Th w={160} fw={400} c="dimmed" style={{ verticalAlign: 'top' }}>
                        {label}
                      </Table.Th>
                      <Table.Td>{value}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
              <Text size="xs" c="dimmed" mt="sm">
                Создан {fmtDateTime(entity.createdAt)} · изменён {fmtDateTime(entity.updatedAt)}
              </Text>
            </Card>
            {config.monitor && <MonitorPanel type={config.monitor} id={id} />}
            {related.map((r) => (
              <RelatedCard
                key={`${r.path}-${r.fk}`}
                title={r.title}
                path={r.path}
                items={r.items}
                onAdd={canInfra('edit') ? () => openCreate(r.path, relatedPrefill(path, entity, r.fk)) : undefined}
              />
            ))}
          </Stack>
        </Grid.Col>
        <Grid.Col span={{ base: 12, lg: 5 }}>
          <CredentialsCard
            entityType={config.type}
            entityId={id}
            defaultKind={config.defaultCredentialKind}
            fallbackHost={sshFallback}
          />
        </Grid.Col>
      </Grid>

      <EntityDrawer path={path} entity={entity} opened={editing} onClose={() => setEditing(false)} />
    </Stack>
  );
}
