import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Modal,
  PasswordInput,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconPencil, IconPlus, IconTrash, IconWand } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { generatePassword } from '../../shared/password';
import type { SystemRole, UserRow } from '../../shared/types';
import { api, ApiError } from '../api';
import { systemRoleLabels, useAuth } from '../auth';
import { FormFooter } from '../components/FormFooter';
import { fmtDateTime } from '../format';

const roleOptions = (Object.keys(systemRoleLabels) as SystemRole[]).map((r) => ({ value: r, label: systemRoleLabels[r] }));
const roleColors: Record<SystemRole, string> = { admin: 'red', user: 'gray' };

function UserForm({ user, onDone }: { user: UserRow | null; onDone: () => void }) {
  const qc = useQueryClient();
  const form = useForm({
    initialValues: {
      email: user?.email ?? '',
      name: user?.name ?? '',
      role: user?.role ?? 'user',
      password: '',
      disabled: user?.disabled ?? false,
      resetTotp: false,
    },
  });

  const save = useMutation({
    mutationFn: (v: typeof form.values) =>
      user
        ? api.patch(`/api/users/${user.id}`, {
            name: v.name,
            role: v.role,
            disabled: v.disabled,
            ...(v.password ? { password: v.password } : {}),
            ...(v.resetTotp ? { resetTotp: true } : {}),
          })
        : api.post('/api/users', { email: v.email, name: v.name, role: v.role, password: v.password }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      notifications.show({ color: 'teal', message: user ? 'Сохранено' : 'Пользователь создан со своим пространством. Не забудьте передать пароль' });
      onDone();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fields) form.setErrors(e.fields);
      notifications.show({ color: 'red', message: e.message });
    },
  });

  return (
    <form onSubmit={form.onSubmit((v) => save.mutate(v))}>
      <Stack>
        <TextInput label="Email" type="email" required disabled={!!user} {...form.getInputProps('email')} />
        <TextInput label="Имя" required {...form.getInputProps('name')} />
        <Select
          label="Роль"
          data={roleOptions}
          allowDeselect={false}
          description="Системная роль. Администратор системы управляет пользователями, но в чужие пространства не заходит: доступ к данным даётся приглашением в пространство."
          {...form.getInputProps('role')}
        />
        <Group align="flex-end" wrap="nowrap">
          <PasswordInput
            label={user ? 'Новый пароль' : 'Пароль'}
            placeholder={user ? 'Оставьте пустым, чтобы не менять' : 'Не короче 10 символов'}
            required={!user}
            style={{ flex: 1 }}
            autoComplete="new-password"
            {...form.getInputProps('password')}
          />
          <Tooltip label="Сгенерировать">
            <ActionIcon size="lg" variant="default" onClick={() => form.setFieldValue('password', generatePassword(16))}>
              <IconWand size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
        {form.values.password && (
          <Text size="xs" c="dimmed">
            Пароль: <span className="mono">{form.values.password}</span>
          </Text>
        )}
        {user && (
          <>
            <Checkbox label="Заблокировать доступ" {...form.getInputProps('disabled', { type: 'checkbox' })} />
            {user.totpEnabled && <Checkbox label="Сбросить 2FA (если потерян телефон)" {...form.getInputProps('resetTotp', { type: 'checkbox' })} />}
          </>
        )}
        <FormFooter onCancel={onDone} type="submit" loading={save.isPending}>
          {user ? 'Сохранить' : 'Создать'}
        </FormFooter>
      </Stack>
    </form>
  );
}

export function UsersPage() {
  const { user: me } = useAuth();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<UserRow[]>('/api/users') });

  const remove = (u: UserRow) =>
    modals.openConfirmModal({
      title: `Удалить ${u.name}?`,
      children: <Text size="sm">Пользователь потеряет доступ к панели. Записи в журнале сохранятся.</Text>,
      confirmProps: { color: 'red' },
      labels: { confirm: 'Удалить', cancel: 'Отмена' },
      onConfirm: async () => {
        try {
          await api.del(`/api/users/${u.id}`);
          qc.invalidateQueries({ queryKey: ['users'] });
        } catch (e) {
          notifications.show({ color: 'red', message: (e as Error).message });
        }
      },
    });

  return (
    <Stack>
      <Group justify="space-between">
        <Title order={2}>Пользователи</Title>
        <Button leftSection={<IconPlus size={16} />} onClick={() => setEditing('new')}>
          Добавить
        </Button>
      </Group>
      <Card withBorder p={0}>
        <Table.ScrollContainer minWidth={640}>
          <Table verticalSpacing="sm">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Пользователь</Table.Th>
                <Table.Th>Роль</Table.Th>
                <Table.Th>2FA</Table.Th>
                <Table.Th>Последний вход</Table.Th>
                <Table.Th w={80} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {users.data?.map((u) => (
                <Table.Tr key={u.id} opacity={u.disabled ? 0.5 : 1}>
                  <Table.Td>
                    <Text fw={500} size="sm">
                      {u.name} {u.id === me.id && <Text span c="dimmed" size="xs">(вы)</Text>}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {u.email ?? 'вход без пароля'}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Badge color={roleColors[u.role]} variant="light">
                      {systemRoleLabels[u.role]}
                    </Badge>
                    {u.disabled && (
                      <Badge color="gray" ml={4}>
                        заблокирован
                      </Badge>
                    )}
                  </Table.Td>
                  <Table.Td>{u.totpEnabled ? <Badge color="teal" variant="light">вкл</Badge> : <Text size="sm" c="dimmed">нет</Text>}</Table.Td>
                  <Table.Td>
                    <Text size="sm">{fmtDateTime(u.lastLoginAt)}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={2} wrap="nowrap">
                      <ActionIcon variant="subtle" color="gray" onClick={() => setEditing(u)} aria-label="Изменить">
                        <IconPencil size={16} />
                      </ActionIcon>
                      {u.id !== me.id && (
                        <ActionIcon variant="subtle" color="red" onClick={() => remove(u)} aria-label="Удалить">
                          <IconTrash size={16} />
                        </ActionIcon>
                      )}
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      </Card>
      <Modal opened={editing !== null} onClose={() => setEditing(null)} title={editing === 'new' ? 'Новый пользователь' : 'Изменить пользователя'}>
        {editing !== null && <UserForm user={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />}
      </Modal>
    </Stack>
  );
}
