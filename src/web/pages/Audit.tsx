import { Badge, Card, Group, SegmentedControl, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { IconSearch } from '@tabler/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import type { AuditEntry } from '../../shared/types';
import { api } from '../api';
import { configByType } from '../entities';
import { fmtDateTime } from '../format';
import { webModules } from '../modules';

const actionLabels: Record<string, { label: string; color: string }> = {
  login: { label: 'Вход', color: 'gray' },
  'login.failed': { label: 'Неудачный вход', color: 'red' },
  'login.totp_failed': { label: 'Неверный код 2FA', color: 'red' },
  'login.totp_locked': { label: 'Вход кодом 2FA закрыт на 15 минут', color: 'red' },
  'credential.reveal': { label: 'Просмотр пароля', color: 'orange' },
  'credential.create': { label: 'Добавлен доступ', color: 'indigo' },
  'credential.update': { label: 'Изменён доступ', color: 'indigo' },
  'credential.delete': { label: 'Удалён доступ', color: 'red' },
  'entity.create': { label: 'Создание', color: 'teal' },
  'entity.update': { label: 'Изменение', color: 'blue' },
  'entity.delete': { label: 'Удаление', color: 'red' },
  'user.create': { label: 'Новый пользователь', color: 'grape' },
  'user.update': { label: 'Изменён пользователь', color: 'grape' },
  'user.reset_by_admin': { label: 'Администратор сбросил пароль или 2FA', color: 'red' },
  'user.delete': { label: 'Удалён пользователь', color: 'red' },
  'user.password_changed': { label: 'Смена пароля', color: 'grape' },
  'user.totp_enabled': { label: '2FA включена', color: 'grape' },
  'user.totp_disabled': { label: '2FA выключена', color: 'orange' },
  'settings.telegram_test': { label: 'Тест Telegram', color: 'gray' },
  'user.register': { label: 'Регистрация по приглашению', color: 'grape' },
  'user.telegram_unlinked': { label: 'Telegram отвязан', color: 'gray' },
  'workspace.create': { label: 'Новое пространство', color: 'teal' },
  'workspace.rename': { label: 'Пространство переименовано', color: 'blue' },
  'workspace.delete': { label: 'Пространство удалено', color: 'red' },
  'member.update': { label: 'Права участника', color: 'grape' },
  'member.remove': { label: 'Участник убран', color: 'red' },
  'member.leave': { label: 'Участник вышел', color: 'gray' },
  'member.make_owner': { label: 'Передано владение', color: 'yellow' },
  'invite.create': { label: 'Приглашение', color: 'indigo' },
  'invite.revoke': { label: 'Приглашение отозвано', color: 'gray' },
  'invite.accept': { label: 'Вступил по приглашению', color: 'teal' },
  'channel.create': { label: 'Канал оповещений добавлен', color: 'indigo' },
  'channel.update': { label: 'Канал оповещений изменён', color: 'indigo' },
  'channel.delete': { label: 'Канал оповещений удалён', color: 'red' },
  'system.module': { label: 'Модуль на сайте', color: 'orange' },
  'workspace.module': { label: 'Модуль в пространстве', color: 'orange' },
};

// Сущности инфраструктуры называются по entityConfigs (accusative), здесь — остальные
const typeLabels: Record<string, string> = {
  credential: 'доступ',
  user: 'пользователь',
  channel: 'канал оповещений',
};

// Подписи действий модулей — из их описания
const actionLabel = (action: string) => actionLabels[action] ?? webModules().find((m) => m.auditActions?.[action])?.auditActions![action];
const typeLabel = (type: string) => typeLabels[type] ?? webModules().find((m) => m.auditEntities?.[type])?.auditEntities![type];

const filters: Record<string, { label: string; test: (a: AuditEntry) => boolean }> = {
  all: { label: 'Все', test: () => true },
  secrets: { label: 'Просмотры паролей', test: (a) => a.action === 'credential.reveal' },
  logins: { label: 'Входы', test: (a) => a.action.startsWith('login') },
  changes: { label: 'Изменения', test: (a) => !a.action.startsWith('login') && a.action !== 'credential.reveal' },
};

export function AuditPage({ scope }: { scope: 'workspace' | 'system' }) {
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const q = useQuery({ queryKey: ['audit', scope], queryFn: () => api.get<AuditEntry[]>(`/api/audit?limit=1000&scope=${scope}`), refetchInterval: 30_000 });
  const s = search.trim().toLowerCase();
  const rows = (q.data ?? []).filter(filters[filter].test).filter((a) => !s || `${a.userEmail} ${a.details} ${a.ip}`.toLowerCase().includes(s));

  return (
    <Stack>
      <Title order={2}>{scope === 'system' ? 'Системный журнал' : 'Журнал пространства'}</Title>
      <Group justify="space-between">
        <SegmentedControl value={filter} onChange={setFilter} data={Object.entries(filters).map(([value, f]) => ({ value, label: f.label }))} />
        <TextInput placeholder="Поиск" leftSection={<IconSearch size={16} />} value={search} onChange={(e) => setSearch(e.currentTarget.value)} />
      </Group>
      <Card withBorder p={0}>
        <Table.ScrollContainer minWidth={760}>
          <Table verticalSpacing="xs" striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={140}>Время</Table.Th>
                <Table.Th>Кто</Table.Th>
                <Table.Th>Действие</Table.Th>
                <Table.Th>Подробности</Table.Th>
                <Table.Th>IP</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {rows.map((a) => {
                const meta = actionLabel(a.action) ?? { label: a.action, color: 'gray' };
                return (
                  <Table.Tr key={a.id}>
                    <Table.Td>
                      <Text size="xs">{fmtDateTime(a.createdAt)}</Text>
                    </Table.Td>
                    <Table.Td>{a.userEmail ?? '—'}</Table.Td>
                    <Table.Td>
                      <Badge color={meta.color} variant="light">
                        {meta.label}
                      </Badge>
                      {a.entityType && (
                        <Text span size="xs" c="dimmed" ml={6}>
                          {configByType[a.entityType]?.accusative ?? typeLabel(a.entityType) ?? a.entityType}
                        </Text>
                      )}
                    </Table.Td>
                    <Table.Td>{a.details}</Table.Td>
                    <Table.Td>
                      <Text size="xs" className="mono">
                        {a.ip}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                );
              })}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
    </Stack>
  );
}
