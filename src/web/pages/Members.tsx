import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  CopyButton,
  Group,
  Menu,
  Modal,
  NumberInput,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconCheck, IconCopy, IconCrown, IconDots, IconLink, IconTrash, IconUserPlus } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { InfraAccess, InviteRow, MemberRow, ModuleLevels } from '../../shared/types';
import { api } from '../api';
import { infraLabels, useAuth } from '../auth';
import { FormFooter } from '../components/FormFooter';
import { fmtDate, fmtDateTime } from '../format';
import { levelLabel, modulesIn, type WebModule } from '../modules';

const INFRA: InfraAccess[] = ['none', 'view', 'edit'];

/**
 * Варианты прав: не-владелец не может выдать больше, чем есть у него. Модули — только работающие
 * в пространстве: выключенного не видно, и его сохранённые права не трогаются
 */
function useLevels() {
  const { ws } = useAuth();
  const infra = INFRA.map((v) => ({ value: v, label: infraLabels[v], disabled: !ws.isOwner && INFRA.indexOf(v) > INFRA.indexOf(ws.infra) }));
  const rank = (m: WebModule, level: string | undefined) => m.levels.findIndex((l) => l.value === (level ?? 'none'));
  const modules = modulesIn(ws).map((m) => ({
    m,
    data: m.levels.map((l) => ({ ...l, disabled: !ws.isOwner && rank(m, l.value) > rank(m, ws.modules[m.id]) })),
  }));
  return { infra, modules };
}

function MemberRowView({ m }: { m: MemberRow }) {
  const { ws, user } = useAuth();
  const qc = useQueryClient();
  const levels = useLevels();
  const editable = !m.isOwner && m.userId !== user.id && (ws.isOwner || !m.canManageMembers);

  // Уровни модулей сервер сливает с сохранёнными: шлём только изменённый модуль
  const update = useMutation({
    mutationFn: (patch: Partial<Pick<MemberRow, 'infraAccess' | 'modules' | 'canManageMembers'>>) =>
      api.patch(`/api/members/${m.id}`, { infraAccess: m.infraAccess, canManageMembers: m.canManageMembers, modules: {}, ...patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['members'] }),
    onError: (e) => notifications.show({ color: 'red', message: e.message }),
  });

  const remove = () =>
    modals.openConfirmModal({
      title: `Убрать ${m.name} из пространства?`,
      children: <Text size="sm">Доступ к данным пространства пропадёт сразу.</Text>,
      confirmProps: { color: 'red' },
      labels: { confirm: 'Убрать', cancel: 'Отмена' },
      onConfirm: async () => {
        await api.del(`/api/members/${m.id}`).catch((e) => notifications.show({ color: 'red', message: e.message }));
        qc.invalidateQueries({ queryKey: ['members'] });
      },
    });

  const makeOwner = () =>
    modals.openConfirmModal({
      title: `Передать владение ${m.name}?`,
      children: <Text size="sm">Вы останетесь участником с полными правами и правом управлять участниками, но владельцем станет {m.name}.</Text>,
      labels: { confirm: 'Передать', cancel: 'Отмена' },
      onConfirm: async () => {
        await api.post(`/api/members/${m.id}/make-owner`).catch((e) => notifications.show({ color: 'red', message: e.message }));
        qc.invalidateQueries();
      },
    });

  return (
    <Table.Tr>
      <Table.Td>
        <Text size="sm" fw={500}>
          {m.name} {m.userId === user.id && <Text span c="dimmed" size="xs">(вы)</Text>}
        </Text>
        <Text size="xs" c="dimmed">
          {m.email ?? 'вход без пароля'}
          {!m.totpEnabled && ' · без 2FA'}
        </Text>
        {m.isOwner && (
          <Badge color="yellow" variant="light" size="sm" mt={4} leftSection={<IconCrown size={12} />} tt="none">
            владелец
          </Badge>
        )}
      </Table.Td>
      <Table.Td>
        <Select
          size="xs"
          w={160}
          data={levels.infra}
          value={m.isOwner ? 'edit' : m.infraAccess}
          disabled={!editable}
          allowDeselect={false}
          onChange={(v) => v && update.mutate({ infraAccess: v as InfraAccess })}
        />
      </Table.Td>
      {levels.modules.map(({ m: mod, data }) => (
        <Table.Td key={mod.id}>
          <Select
            size="xs"
            w={140}
            data={data}
            value={m.isOwner ? mod.levels[mod.levels.length - 1].value : (m.modules[mod.id] ?? 'none')}
            disabled={!editable}
            allowDeselect={false}
            onChange={(v) => v && update.mutate({ modules: { [mod.id]: v } })}
          />
        </Table.Td>
      ))}
      <Table.Td>
        <Tooltip label="Назначать управляющих может только владелец" disabled={ws.isOwner}>
          <Checkbox
            checked={m.isOwner || m.canManageMembers}
            disabled={!editable || !ws.isOwner}
            onChange={(e) => update.mutate({ canManageMembers: e.currentTarget.checked })}
          />
        </Tooltip>
      </Table.Td>
      <Table.Td>
        <Text size="xs" c="dimmed">
          {fmtDateTime(m.lastLoginAt)}
        </Text>
      </Table.Td>
      <Table.Td>
        {editable && (
          <Menu position="bottom-end">
            <Menu.Target>
              <ActionIcon variant="subtle" color="gray" aria-label="Действия">
                <IconDots size={16} />
              </ActionIcon>
            </Menu.Target>
            <Menu.Dropdown>
              {ws.isOwner && (
                <Menu.Item leftSection={<IconCrown size={14} />} onClick={makeOwner}>
                  Сделать владельцем
                </Menu.Item>
              )}
              <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={remove}>
                Убрать из пространства
              </Menu.Item>
            </Menu.Dropdown>
          </Menu>
        )}
      </Table.Td>
    </Table.Tr>
  );
}

function InviteModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { ws } = useAuth();
  const qc = useQueryClient();
  const levels = useLevels();
  const [infraAccess, setInfra] = useState<InfraAccess>('none');
  // Выключенный модуль скрыт, и приглашение его не выдаёт: после включения не всплывут невидимые права.
  // Работающим — по умолчанию первый уровень (просмотр), если его можно выдать
  const [modules, setModules] = useState<ModuleLevels>(() =>
    Object.fromEntries(levels.modules.map(({ m, data }) => [m.id, data[1].disabled ? 'none' : m.levels[1].value])),
  );
  const [canManageMembers, setManage] = useState(false);
  const [note, setNote] = useState('');
  const [ttlDays, setTtl] = useState<number | string>(7);
  const [url, setUrl] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post<{ url: string; token: string }>('/api/invites', { infraAccess, modules, canManageMembers, note, ttlDays: Number(ttlDays) || 7 }),
    onSuccess: (r) => {
      setUrl(r.url.startsWith('http') ? r.url : `${window.location.origin}/invite/${r.token}`);
      qc.invalidateQueries({ queryKey: ['invites'] });
    },
    onError: (e) => notifications.show({ color: 'red', message: e.message }),
  });

  const close = () => {
    setUrl(null);
    setNote('');
    onClose();
  };

  return (
    <Modal opened={opened} onClose={close} title="Пригласить в пространство" size="lg">
      {url ? (
        <Stack>
          <Alert color="teal" title="Ссылка готова">
            Отправьте её человеку. Ссылка одноразовая: сработает для первого, кто её откроет и войдёт. Показывается только сейчас.
          </Alert>
          <Group wrap="nowrap" gap="xs">
            <Code block style={{ flex: 1, wordBreak: 'break-all' }}>
              {url}
            </Code>
            <CopyButton value={url}>
              {({ copied, copy }) => (
                <Button onClick={copy} leftSection={copied ? <IconCheck size={16} /> : <IconCopy size={16} />} color={copied ? 'teal' : undefined}>
                  {copied ? 'Скопировано' : 'Копировать'}
                </Button>
              )}
            </CopyButton>
          </Group>
          <Group justify="flex-end">
            <Button onClick={close}>Готово</Button>
          </Group>
        </Stack>
      ) : (
        <Stack>
          {levels.modules.length > 0 && (
            <Text size="sm" c="dimmed">
              Права выдаются отдельно на инфраструктуру (серверы, сайты, пароли) и на {levels.modules.map(({ m }) => m.title).join(', ')}.{' '}
              {levels.modules.map(({ m }) => m.accessHint).filter(Boolean).join(' ')}
            </Text>
          )}
          <Group grow>
            <Select label="Инфраструктура" data={levels.infra} value={infraAccess} onChange={(v) => setInfra((v ?? 'none') as InfraAccess)} allowDeselect={false} />
            {levels.modules.map(({ m, data }) => (
              <Select
                key={m.id}
                label={m.title}
                data={data}
                value={modules[m.id] ?? 'none'}
                onChange={(v) => setModules({ ...modules, [m.id]: v ?? 'none' })}
                allowDeselect={false}
              />
            ))}
          </Group>
          {ws.isOwner && (
            <Checkbox label="Может управлять участниками и приглашать" checked={canManageMembers} onChange={(e) => setManage(e.currentTarget.checked)} />
          )}
          <Group grow align="flex-start">
            <TextInput label="Для кого" placeholder="Например: Пилот из корпы, Вася-админ" value={note} onChange={(e) => setNote(e.currentTarget.value)} />
            <NumberInput label="Действует, дней" min={1} max={30} value={ttlDays} onChange={setTtl} />
          </Group>
          <FormFooter onCancel={close} leftSection={<IconLink size={16} />} loading={create.isPending} onClick={() => create.mutate()}>
            Создать ссылку
          </FormFooter>
        </Stack>
      )}
    </Modal>
  );
}

function WorkspaceCard() {
  const { ws, refreshMe } = useAuth();
  const [name, setName] = useState(ws.name);
  const [deleting, setDeleting] = useState(false);
  const [confirm, setConfirm] = useState('');

  const rename = useMutation({
    mutationFn: () => api.patch('/api/workspace', { name }),
    onSuccess: () => {
      refreshMe();
      notifications.show({ color: 'teal', message: 'Сохранено' });
    },
    onError: (e) => notifications.show({ color: 'red', message: e.message }),
  });
  const remove = useMutation({
    mutationFn: () => api.del('/api/workspace', { confirmName: confirm }),
    onSuccess: () => {
      setDeleting(false);
      refreshMe();
    },
    onError: (e) => notifications.show({ color: 'red', message: e.message }),
  });

  if (!ws.isOwner) return null;
  return (
    <Card withBorder>
      <Title order={4} mb="sm">
        Пространство
      </Title>
      <Group align="flex-end">
        <TextInput label="Название" value={name} onChange={(e) => setName(e.currentTarget.value)} w={320} maw="100%" />
        <Button variant="default" onClick={() => rename.mutate()} disabled={!name.trim() || name === ws.name} loading={rename.isPending}>
          Переименовать
        </Button>
        <Button color="red" variant="subtle" onClick={() => setDeleting(true)}>
          Удалить пространство
        </Button>
      </Group>
      <Modal opened={deleting} onClose={() => setDeleting(false)} title="Удалить пространство?">
        <Stack>
          <Alert color="red">Удалятся все серверы, сайты, домены, пароли, данные модулей и история пространства «{ws.name}». Отменить нельзя.</Alert>
          <TextInput label={`Введите «${ws.name}» для подтверждения`} value={confirm} onChange={(e) => setConfirm(e.currentTarget.value)} />
          <FormFooter onCancel={() => setDeleting(false)} color="red" disabled={confirm !== ws.name} loading={remove.isPending} onClick={() => remove.mutate()}>
            Удалить навсегда
          </FormFooter>
        </Stack>
      </Modal>
    </Card>
  );
}

export function MembersPage() {
  const { ws } = useAuth();
  const active = modulesIn(ws);
  const qc = useQueryClient();
  const [inviting, setInviting] = useState(false);
  const members = useQuery({ queryKey: ['members'], queryFn: () => api.get<MemberRow[]>('/api/members') });
  const invites = useQuery({ queryKey: ['invites'], queryFn: () => api.get<InviteRow[]>('/api/invites') });

  const revoke = async (id: number) => {
    await api.del(`/api/invites/${id}`);
    qc.invalidateQueries({ queryKey: ['invites'] });
  };

  return (
    <Stack>
      <Group justify="space-between">
        <div>
          <Title order={2}>Участники</Title>
          <Text c="dimmed" size="sm">
            {ws.name}
          </Text>
        </div>
        <Button leftSection={<IconUserPlus size={16} />} onClick={() => setInviting(true)}>
          Пригласить
        </Button>
      </Group>

      <Card withBorder p={0}>
        <Table.ScrollContainer minWidth={760}>
          <Table verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Участник</Table.Th>
                <Table.Th>Инфраструктура</Table.Th>
                {active.map((m) => (
                  <Table.Th key={m.id}>{m.title}</Table.Th>
                ))}
                <Table.Th>Участники</Table.Th>
                <Table.Th>Последний вход</Table.Th>
                <Table.Th w={50} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {members.data?.map((m) => (
                <MemberRowView key={m.id} m={m} />
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>

      {!!invites.data?.length && (
        <Card withBorder>
          <Title order={5} mb="xs">
            Действующие приглашения
          </Title>
          <Table>
            <Table.Tbody>
              {invites.data.map((i) => (
                <Table.Tr key={i.id}>
                  <Table.Td>
                    <Text size="sm">{i.note || 'Без пометки'}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">
                      инфраструктура: {infraLabels[i.infraAccess].toLowerCase()}
                      {active.map((m) => ` · ${m.title}: ${levelLabel(m, i.modules[m.id]).toLowerCase()}`)}
                      {i.canManageMembers && ' · управляет участниками'}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">
                      до {fmtDate(i.expiresAt)}
                    </Text>
                  </Table.Td>
                  <Table.Td w={40}>
                    <ActionIcon variant="subtle" color="red" onClick={() => revoke(i.id)} aria-label="Отозвать">
                      <IconTrash size={16} />
                    </ActionIcon>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Card>
      )}

      <WorkspaceCard />
      <InviteModal opened={inviting} onClose={() => setInviting(false)} />
    </Stack>
  );
}
