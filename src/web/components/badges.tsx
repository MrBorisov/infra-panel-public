import { Badge, Group, Text, Tooltip } from '@mantine/core';
import { daysText, daysUntil, deadlineColor, fmtDate, fromNow } from '../format';

const STATUS = {
  up: { color: 'teal', label: 'Работает' },
  down: { color: 'red', label: 'Недоступен' },
  unknown: { color: 'gray', label: 'Нет данных' },
} as const;

export function StatusBadge({
  status,
  monitorEnabled = true,
  lastCheckAt,
  error,
}: {
  status: 'up' | 'down' | 'unknown';
  monitorEnabled?: boolean;
  lastCheckAt?: number | null;
  error?: string | null;
}) {
  if (!monitorEnabled) {
    return (
      <Badge color="gray" variant="outline">
        Не проверяется
      </Badge>
    );
  }
  const s = STATUS[status];
  const tip = [error, lastCheckAt ? `Проверено ${fromNow(lastCheckAt)}` : null].filter(Boolean).join(' · ');
  return (
    <Tooltip label={tip} disabled={!tip} multiline maw={320}>
      <Badge color={s.color} variant={status === 'unknown' ? 'light' : 'filled'}>
        {s.label}
      </Badge>
    </Tooltip>
  );
}

export function DeadlineBadge({ date, withDate = true }: { date: string | number | null | undefined; withDate?: boolean }) {
  if (!date) return <>—</>;
  const days = daysUntil(date);
  const badge = (
    <Badge color={deadlineColor(days)} variant={days <= 7 ? 'filled' : 'light'} tt="none" style={{ flexShrink: 0 }}>
      {daysText(days)}
    </Badge>
  );
  if (!withDate) return <Tooltip label={fmtDate(date)}>{badge}</Tooltip>;
  return (
    <Group gap={6} wrap="nowrap">
      <Text size="sm" style={{ whiteSpace: 'nowrap' }}>
        {fmtDate(date)}
      </Text>
      {badge}
    </Group>
  );
}
