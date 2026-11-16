import {
  ActionIcon,
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  Code,
  Group,
  Image,
  PasswordInput,
  PinInput,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconLogout, IconPlus, IconRocket, IconShieldCheck, IconTrash } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import type { Settings } from '../../shared/types';
import { api, ApiError } from '../api';
import { systemRoleLabels, useAuth } from '../auth';
import { webModules } from '../modules';

function PasswordCard() {
  const form = useForm({ initialValues: { current: '', next: '', repeat: '' } });
  const save = useMutation({
    mutationFn: (v: typeof form.values) => api.post('/api/me/password', { current: v.current, next: v.next }),
    onSuccess: () => {
      form.reset();
      notifications.show({ color: 'teal', message: 'Пароль изменён. Остальные сессии завершены' });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fields?.next) form.setFieldError('next', e.fields.next);
      notifications.show({ color: 'red', message: e.message });
    },
  });

  return (
    <Card withBorder>
      <Title order={4} mb="sm">
        Смена пароля
      </Title>
      <form
        onSubmit={form.onSubmit((v) => {
          if (v.next !== v.repeat) return form.setFieldError('repeat', 'Пароли не совпадают');
          save.mutate(v);
        })}
      >
        <Stack maw={360}>
          <PasswordInput label="Текущий пароль" autoComplete="current-password" required {...form.getInputProps('current')} />
          <PasswordInput label="Новый пароль" autoComplete="new-password" description="Не короче 10 символов" required {...form.getInputProps('next')} />
          <PasswordInput label="Повторите новый пароль" autoComplete="new-password" required {...form.getInputProps('repeat')} />
          <Button type="submit" loading={save.isPending} w="fit-content">
            Сменить пароль
          </Button>
        </Stack>
      </form>
    </Card>
  );
}

function TotpCard() {
  const { user, refreshMe } = useAuth();
  const [setup, setSetup] = useState<{ qr: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [disableCode, setDisableCode] = useState('');

  const start = useMutation({
    mutationFn: () => api.post<{ qr: string; secret: string }>('/api/me/totp/setup'),
    onSuccess: setSetup,
    onError: (e) => notifications.show({ color: 'red', message: e.message }),
  });
  const enable = useMutation({
    mutationFn: (c: string) => api.post('/api/me/totp/enable', { code: c }),
    onSuccess: () => {
      setSetup(null);
      refreshMe();
      notifications.show({ color: 'teal', message: '2FA включена' });
    },
    onError: (e) => {
      setCode('');
      notifications.show({ color: 'red', message: e.message });
    },
  });
  const disable = useMutation({
    mutationFn: () => api.post('/api/me/totp/disable', user.hasPassword ? { password } : { code: disableCode }),
    onSuccess: () => {
      setPassword('');
      setDisableCode('');
      refreshMe();
      notifications.show({ color: 'teal', message: '2FA выключена' });
    },
    onError: (e) => notifications.show({ color: 'red', message: e.message }),
  });

  return (
    <Card withBorder>
      <Group justify="space-between" mb="sm">
        <Title order={4}>Двухфакторная аутентификация</Title>
        {user.totpEnabled ? <Badge color="teal">включена</Badge> : <Badge color="gray">выключена</Badge>}
      </Group>

      {user.totpEnabled ? (
        <Stack maw={360}>
          <Text size="sm" c="dimmed">
            {user.hasPassword ? 'Чтобы выключить 2FA, введите пароль от панели.' : 'Чтобы выключить 2FA, введите текущий код из приложения.'}
          </Text>
          {user.hasPassword ? (
            <PasswordInput placeholder="Пароль" value={password} onChange={(e) => setPassword(e.currentTarget.value)} />
          ) : (
            <PinInput length={6} type="number" value={disableCode} onChange={setDisableCode} />
          )}
          <Button
            color="red"
            variant="light"
            w="fit-content"
            disabled={user.hasPassword ? !password : disableCode.length < 6}
            loading={disable.isPending}
            onClick={() => disable.mutate()}
          >
            Выключить 2FA
          </Button>
        </Stack>
      ) : setup ? (
        <Stack>
          <Text size="sm">1. Отсканируйте QR-код в приложении-аутентификаторе (Google Authenticator, Яндекс Ключ, 1Password, Passwork и т. п.)</Text>
          <Image src={setup.qr} w={200} h={200} radius="sm" />
          <Text size="xs" c="dimmed">
            Или введите ключ вручную: <Code>{setup.secret}</Code>
          </Text>
          <Text size="sm">2. Введите код из приложения:</Text>
          <PinInput length={6} type="number" oneTimeCode value={code} onChange={setCode} onComplete={(v) => enable.mutate(v)} disabled={enable.isPending} />
        </Stack>
      ) : (
        <Stack align="flex-start">
          <Text size="sm" c="dimmed">
            Помимо пароля или другого способа входа понадобится код из приложения на телефоне. Для панели с паролями от серверов это обязательно.
          </Text>
          <Button leftSection={<IconShieldCheck size={16} />} loading={start.isPending} onClick={() => start.mutate()}>
            Включить 2FA
          </Button>
        </Stack>
      )}
    </Card>
  );
}


function LeaveWorkspaceCard() {
  const { ws, refreshMe } = useAuth();
  if (ws.isOwner) return null;
  const leave = () =>
    modals.openConfirmModal({
      title: `Покинуть «${ws.name}»?`,
      children: <Text size="sm">Доступ к данным пространства пропадёт. Вернуться можно только по новому приглашению.</Text>,
      confirmProps: { color: 'red' },
      labels: { confirm: 'Покинуть', cancel: 'Отмена' },
      onConfirm: async () => {
        await api.post('/api/workspace/leave');
        refreshMe();
      },
    });
  return (
    <Card withBorder>
      <Group justify="space-between">
        <div>
          <Title order={5}>Пространство «{ws.name}»</Title>
          <Text size="sm" c="dimmed">
            Вы участник этого пространства
          </Text>
        </div>
        <Button variant="subtle" color="red" leftSection={<IconLogout size={16} />} onClick={leave}>
          Покинуть
        </Button>
      </Group>
    </Card>
  );
}

function SystemCard() {
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Settings>('/api/settings') });
  const s = settings.data;
  if (!s) return null;
  return (
    <Card withBorder>
      <Title order={4} mb="sm">
        Система
      </Title>
      <Table variant="vertical" withRowBorders={false} layout="fixed" maw={560}>
        <Table.Tbody>
          <Table.Tr>
            <Table.Th w={220} fw={400} c="dimmed">
              Мониторинг
            </Table.Th>
            <Table.Td>{s.monitorEnabled ? `каждые ${s.checkIntervalSec} с, авария после ${s.failThreshold} неудачных проверок подряд` : 'выключен'}</Table.Td>
          </Table.Tr>
          <Table.Tr>
            <Table.Th fw={400} c="dimmed">
              Ссылки в оповещениях
            </Table.Th>
            <Table.Td>{s.publicUrl || <Text c="dimmed" size="sm">PUBLIC_URL не задан</Text>}</Table.Td>
          </Table.Tr>
        </Table.Tbody>
      </Table>
    </Card>
  );
}

export function SettingsPage() {
  const { user, isSysAdmin } = useAuth();
  return (
    <Stack>
      <Title order={2}>Настройки</Title>
      <Text c="dimmed" size="sm">
        {[user.name, user.email, systemRoleLabels[user.role]].filter(Boolean).join(' · ')}
      </Text>
      <TotpCard />
      {/* Карточки модулей уровня пользователя — сами решают, показываться ли */}
      {webModules().flatMap((m) => (m.settingsCards ?? []).map((Card, i) => <Card key={`${m.id}-${i}`} />))}
      {user.hasPassword && <PasswordCard />}
      <LeaveWorkspaceCard />
      {isSysAdmin && <SystemCard />}
    </Stack>
  );
}
