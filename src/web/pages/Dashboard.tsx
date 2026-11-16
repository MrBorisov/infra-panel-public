import { Anchor, Badge, Card, Group, SimpleGrid, Stack, Table, Text, ThemeIcon, Title } from '@mantine/core';
import { IconAlertTriangle, IconCircleCheck, IconCreditCard, IconLock, IconWorldWww } from '@tabler/icons-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { Dashboard, Deadline, EventEntry } from '../../shared/types';
import { useAuth } from '../auth';
import { DeadlineBadge } from '../components/badges';
import { PageLoader } from '../components/PageState';
import { configByType } from '../entities';
import { fmtDate, fmtDateTime, fmtMoney, fromNow } from '../format';
import { hasModuleLevel, modulesIn, webModules } from '../modules';
import { useDashboard } from '../queries';

/** Куда ведёт событие журнала: объект учёта или страница модуля */
function eventLink(e: EventEntry) {
  const core = configByType[e.entityType];
  if (core) return `/${core.path}/${e.entityId}`;
  for (const m of webModules()) {
    const to = m.eventLink?.(e);
    if (to) return to;
  }
  return '/';
}

const deadlineMeta: Record<Deadline['kind'], { label: string; icon: ReactNode }> = {
  domain: { label: 'Домен', icon: <IconWorldWww size={14} /> },
  ssl: { label: 'SSL', icon: <IconLock size={14} /> },
  server_payment: { label: 'Оплата сервера', icon: <IconCreditCard size={14} /> },
  hosting_payment: { label: 'Оплата хостинга', icon: <IconCreditCard size={14} /> },
};

function Stat({ label, value, sub, to }: { label: string; value: ReactNode; sub?: ReactNode; to: string }) {
  return (
    <Card withBorder component={Link} to={to} style={{ textDecoration: 'none' }}>
      <Text size="sm" c="dimmed">
        {label}
      </Text>
      <Text fw={700} size="xl" mt={4}>
        {value}
      </Text>
      {sub && (
        <Text size="xs" c="dimmed" mt={2}>
          {sub}
        </Text>
      )}
    </Card>
  );
}

function upSub(c: Dashboard['counts']['servers']) {
  if (!c.monitored) return 'мониторинг не настроен';
  return (
    <>
      <Text span c="teal" size="xs">
        {c.up} работает
      </Text>
      {c.down > 0 && (
        <Text span c="red" size="xs" fw={600}>
          {' '}
          · {c.down} недоступно
        </Text>
      )}
    </>
  );
}

function InfraDashboard() {
  const d = useDashboard().data;
  if (!d) return <PageLoader />;

  const costs = Object.entries(d.costs);

  return (
    <Stack>
      <SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }}>
        <Stat label="Серверы" value={d.counts.servers.total} sub={upSub(d.counts.servers)} to="/servers" />
        <Stat label="Сайты" value={d.counts.sites.total} sub={upSub(d.counts.sites)} to="/sites" />
        <Stat label="Домены" value={d.counts.domains} to="/domains" />
        <Stat label="Хостинг" value={d.counts.hostings} sub={`аккаунтов: ${d.counts.accounts}`} to="/hostings" />
        <Card withBorder>
          <Text size="sm" c="dimmed">
            Расходы в месяц
          </Text>
          {costs.length === 0 ? (
            <Text fw={700} size="xl" mt={4}>
              —
            </Text>
          ) : (
            costs.map(([cur, sum]) => (
              <Text key={cur} fw={700} size={costs.length > 1 ? 'md' : 'xl'} mt={4}>
                {fmtMoney(sum, cur)}
              </Text>
            ))
          )}
        </Card>
      </SimpleGrid>

      <Card withBorder>
        <Title order={4} mb="sm">
          Сейчас не работает
        </Title>
        {d.down.length === 0 ? (
          <Group gap="xs">
            <ThemeIcon color="teal" variant="light" radius="xl">
              <IconCircleCheck size={18} />
            </ThemeIcon>
            <Text>Всё работает</Text>
          </Group>
        ) : (
          <Table>
            <Table.Tbody>
              {d.down.map((x) => (
                <Table.Tr key={`${x.type}-${x.id}`}>
                  <Table.Td w={36}>
                    <IconAlertTriangle size={18} color="var(--mantine-color-red-6)" />
                  </Table.Td>
                  <Table.Td>
                    <Anchor component={Link} to={`/${x.type}s/${x.id}`} fw={500}>
                      {x.name}
                    </Anchor>
                    <Text size="xs" c="dimmed" className="mono">
                      {x.target}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="red">
                      {x.error}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm" c="dimmed">
                      {fromNow(x.since)}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Card>

      <SimpleGrid cols={{ base: 1, lg: 2 }}>
        <Card withBorder>
          <Title order={4} mb="sm">
            Ближайшие сроки
          </Title>
          {d.deadlines.length === 0 ? (
            <Text c="dimmed" size="sm">
              В ближайшие 30 дней ничего не истекает
            </Text>
          ) : (
            <Table.ScrollContainer minWidth={420}>
              <Table verticalSpacing={6}>
                <Table.Tbody>
                  {d.deadlines.map((x) => (
                    <Table.Tr key={`${x.kind}-${x.entityId}`}>
                      <Table.Td>
                        <Badge variant="light" color="gray" leftSection={deadlineMeta[x.kind].icon}>
                          {deadlineMeta[x.kind].label}
                        </Badge>
                      </Table.Td>
                      <Table.Td>
                        <Anchor component={Link} to={x.path} size="sm">
                          {x.name}
                        </Anchor>
                      </Table.Td>
                      <Table.Td>{fmtDate(x.date)}</Table.Td>
                      <Table.Td>
                        <DeadlineBadge date={x.date} withDate={false} />
                      </Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </Table.ScrollContainer>
          )}
        </Card>

        <Card withBorder>
          <Title order={4} mb="sm">
            Последние события
          </Title>
          {d.events.length === 0 ? (
            <Text c="dimmed" size="sm">
              Событий пока нет
            </Text>
          ) : (
            <Stack gap={6}>
              {d.events.map((e) => (
                <Group key={e.id} gap="xs" wrap="nowrap" align="flex-start">
                  <Text size="xs" c="dimmed" w={110} style={{ flexShrink: 0 }}>
                    {fmtDateTime(e.createdAt)}
                  </Text>
                  <Anchor
                    component={Link}
                    to={eventLink(e)}
                    size="sm"
                    c={e.kind === 'down' ? 'red' : e.kind === 'up' ? 'teal' : undefined}
                  >
                    {e.message}
                  </Anchor>
                </Group>
              ))}
            </Stack>
          )}
        </Card>
      </SimpleGrid>
    </Stack>
  );
}


export function DashboardPage() {
  const { ws, canInfra } = useAuth();
  return (
    <Stack>
      <Title order={2}>Обзор</Title>
      {/* Виджеты модулей — тем, у кого есть доступ к модулю */}
      {modulesIn(ws).map((m) => m.dashboard && hasModuleLevel(ws, m.id, m.levels[1].value) && <m.dashboard key={m.id} />)}
      {canInfra('view') && <InfraDashboard />}
    </Stack>
  );
}
