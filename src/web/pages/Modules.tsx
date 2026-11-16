import { Alert, Card, Group, Stack, Switch, Table, Text, Title } from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SystemModules } from '../../shared/types';
import { api } from '../api';
import { PageLoader } from '../components/PageState';

type ModuleInfo = SystemModules['modules'][number];

/** Модули у администратора системы: каждый — для всего сайта и по пространствам */
export function ModulesPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['system-modules'], queryFn: () => api.get<SystemModules>('/api/system/modules') });
  // Переключение меняет меню и права везде, в том числе в своём пространстве, — обновляем всё
  const done = () => qc.invalidateQueries();
  const fail = (e: Error) => notifications.show({ color: 'red', message: e.message });
  const setSite = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => api.patch(`/api/system/modules/${id}`, { enabled }),
    onSuccess: done,
    onError: fail,
  });
  const setWorkspace = useMutation({
    mutationFn: ({ ws, id, enabled }: { ws: number; id: string; enabled: boolean }) => api.patch(`/api/system/workspaces/${ws}/modules/${id}`, { enabled }),
    onSuccess: done,
    onError: fail,
  });

  if (!q.data) return <PageLoader />;
  const { modules, workspaces } = q.data;

  const toggleSite = (m: ModuleInfo, on: boolean) => {
    if (on) return setSite.mutate({ id: m.id, enabled: true });
    modals.openConfirmModal({
      title: `Выключить ${m.title} для всего сайта?`,
      children: (
        <Stack gap="xs">
          <Text size="sm">Модуль пропадёт во всех пространствах: {m.description.toLowerCase()}.</Text>
          {m.offWarning && (
            <Text size="sm" c="red">
              {m.offWarning}
            </Text>
          )}
          <Text size="sm" c="dimmed">
            Права участников и данные модуля сохранятся и вернутся при включении.
          </Text>
        </Stack>
      ),
      confirmProps: { color: 'red' },
      labels: { confirm: 'Выключить', cancel: 'Отмена' },
      onConfirm: () => setSite.mutate({ id: m.id, enabled: false }),
    });
  };

  if (!modules.length) {
    return (
      <Stack>
        <Title order={2}>Модули</Title>
        <Alert color="gray">Модули не подключены: работает только учёт инфраструктуры.</Alert>
      </Stack>
    );
  }

  return (
    <Stack>
      <Title order={2}>Модули</Title>
      {modules.map((m) => (
        <Card withBorder key={m.id}>
          <Stack gap="sm">
            <Group justify="space-between" wrap="nowrap">
              <div>
                <Title order={4}>{m.title}</Title>
                <Text size="sm" c="dimmed">
                  {m.description}
                </Text>
              </div>
              <Switch
                size="md"
                style={{ flexShrink: 0 }}
                label="Для всего сайта"
                checked={m.available && m.enabled}
                disabled={!m.available || setSite.isPending}
                onChange={(e) => toggleSite(m, e.currentTarget.checked)}
              />
            </Group>
            {!m.available && <Alert color="gray">{m.unavailableReason ?? 'Модуль недоступен на этом сервере'} — модуль недоступен.</Alert>}
            {m.available && !m.enabled && (
              <Alert color="orange">{m.title} выключен для всего сайта: переключатели в пространствах сработают после его включения.</Alert>
            )}
          </Stack>
        </Card>
      ))}
      <Card withBorder p={0}>
        <Text size="sm" c="dimmed" p="md">
          В пространстве с выключенным модулем скрыты его разделы и тревоги. Права участников на модуль и его данные сохраняются.
        </Text>
        <Table.ScrollContainer minWidth={560}>
          <Table verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Пространство</Table.Th>
                <Table.Th>Владелец</Table.Th>
                <Table.Th>Участников</Table.Th>
                {modules.map((m) => [
                  m.counterLabel && <Table.Th key={`${m.id}-count`}>{m.counterLabel}</Table.Th>,
                  <Table.Th key={m.id} w={100}>
                    {m.title}
                  </Table.Th>,
                ])}
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {workspaces.map((w) => (
                <Table.Tr key={w.id}>
                  <Table.Td>
                    <Text fw={500} size="sm">
                      {w.name}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{w.owner ?? '—'}</Text>
                  </Table.Td>
                  <Table.Td>{w.members}</Table.Td>
                  {modules.map((m) => {
                    const state = w.modules[m.id];
                    return [
                      m.counterLabel && <Table.Td key={`${m.id}-count`}>{state?.count || '—'}</Table.Td>,
                      <Table.Td key={m.id}>
                        <Switch
                          checked={state?.enabled ?? true}
                          disabled={setWorkspace.isPending}
                          onChange={(e) => setWorkspace.mutate({ ws: w.id, id: m.id, enabled: e.currentTarget.checked })}
                          aria-label={`${m.title} в пространстве ${w.name}`}
                        />
                      </Table.Td>,
                    ];
                  })}
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
    </Stack>
  );
}
