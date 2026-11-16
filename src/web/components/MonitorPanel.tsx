import { Card, Group, SimpleGrid, Stack, Text, Title, Tooltip } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import dayjs from 'dayjs';
import type { MonitorData } from '../../shared/types';
import { api } from '../api';
import { fmtDateTime, fmtUptime } from '../format';

const BUCKETS = 48; // 24 часа по 30 минут
const BUCKET_MS = 30 * 60_000;

function Heartbeat({ checks }: { checks: MonitorData['checks'] }) {
  const end = Date.now();
  const start = end - BUCKETS * BUCKET_MS;
  const buckets = Array.from({ length: BUCKETS }, (_, i) => ({ from: start + i * BUCKET_MS, ok: 0, fail: 0, latency: [] as number[] }));
  for (const c of checks) {
    const i = Math.floor((c.createdAt - start) / BUCKET_MS);
    const b = buckets[i];
    if (!b) continue;
    if (c.ok) b.ok++;
    else b.fail++;
    if (c.latencyMs != null) b.latency.push(c.latencyMs);
  }

  return (
    <div className="heartbeat">
      {buckets.map((b) => {
        const total = b.ok + b.fail;
        const color = total === 0 ? 'var(--mantine-color-default-border)' : b.fail === 0 ? 'var(--mantine-color-teal-6)' : b.ok === 0 ? 'var(--mantine-color-red-6)' : 'var(--mantine-color-orange-5)';
        const avg = b.latency.length ? Math.round(b.latency.reduce((a, x) => a + x, 0) / b.latency.length) : null;
        const label = `${dayjs(b.from).format('HH:mm')}–${dayjs(b.from + BUCKET_MS).format('HH:mm')}: ${
          total === 0 ? 'нет данных' : `${b.ok} из ${total} успешно${avg != null ? `, ~${avg} мс` : ''}`
        }`;
        return (
          <Tooltip key={b.from} label={label} withArrow>
            <div style={{ background: color }} />
          </Tooltip>
        );
      })}
    </div>
  );
}

export function MonitorPanel({ type, id }: { type: 'server' | 'site'; id: number }) {
  const q = useQuery({
    queryKey: ['monitor', type, id],
    queryFn: () => api.get<MonitorData>(`/api/monitor/${type}/${id}`),
    refetchInterval: 30_000,
  });
  const d = q.data;

  return (
    <Card withBorder>
      <Title order={4} mb="sm">
        Доступность
      </Title>
      <SimpleGrid cols={3} mb="md">
        {(
          [
            ['24 часа', d?.uptime.day],
            ['7 дней', d?.uptime.week],
            ['30 дней', d?.uptime.month],
          ] as const
        ).map(([label, value]) => (
          <Stack key={label} gap={0}>
            <Text size="xs" c="dimmed">
              {label}
            </Text>
            <Text fw={600} size="lg" c={value != null && value < 99 ? 'red' : undefined}>
              {fmtUptime(value ?? null)}
            </Text>
          </Stack>
        ))}
      </SimpleGrid>
      <Heartbeat checks={d?.checks ?? []} />
      <Group justify="space-between" mt={4}>
        <Text size="xs" c="dimmed">
          24 ч назад
        </Text>
        <Text size="xs" c="dimmed">
          сейчас
        </Text>
      </Group>

      {d && d.events.length > 0 && (
        <>
          <Text fw={500} size="sm" mt="md" mb={4}>
            События
          </Text>
          <Stack gap={4}>
            {d.events.slice(0, 10).map((e) => (
              <Group key={e.id} gap="xs" wrap="nowrap" align="flex-start">
                <Text size="xs" c="dimmed" w={110} style={{ flexShrink: 0 }}>
                  {fmtDateTime(e.createdAt)}
                </Text>
                <Text size="xs" c={e.kind === 'down' ? 'red' : e.kind === 'up' ? 'teal' : undefined}>
                  {e.message}
                </Text>
              </Group>
            ))}
          </Stack>
        </>
      )}
    </Card>
  );
}
