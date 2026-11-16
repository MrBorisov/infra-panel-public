import {
  ActionIcon,
  Anchor,
  Badge,
  Button,
  Card,
  Checkbox,
  Code,
  CopyButton,
  Group,
  Modal,
  NumberInput,
  PasswordInput,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import {
  IconCheck,
  IconCopy,
  IconExternalLink,
  IconEye,
  IconEyeOff,
  IconKey,
  IconPencil,
  IconPlus,
  IconTerminal2,
  IconTrash,
} from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import type { Credential, CredentialKind, EntityType } from '../../shared/types';
import { api, ApiError } from '../api';
import { useAuth } from '../auth';
import { credentialBody, defaultPorts, kindLabels, type CredentialDraft } from './credentialKinds';
import { FormFooter } from './FormFooter';

const kindColors: Record<CredentialKind, string> = {
  panel: 'indigo',
  ssh: 'dark',
  sftp: 'cyan',
  ftp: 'cyan',
  admin: 'grape',
  db: 'orange',
  email: 'blue',
  api: 'yellow',
  other: 'gray',
};

const isWebKind = (k: CredentialKind) => k === 'panel' || k === 'admin' || k === 'email';

function CopyIcon({ value, label = 'Скопировать' }: { value: string; label?: string }) {
  return (
    <CopyButton value={value} timeout={1500}>
      {({ copied, copy }) => (
        <Tooltip label={copied ? 'Скопировано' : label} withArrow>
          <ActionIcon variant="subtle" color={copied ? 'teal' : 'gray'} size="sm" onClick={copy}>
            {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
          </ActionIcon>
        </Tooltip>
      )}
    </CopyButton>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Group gap="xs" wrap="nowrap" align="flex-start">
      <Text size="sm" c="dimmed" w={70} style={{ flexShrink: 0 }}>
        {label}
      </Text>
      <Group gap={4} wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
        {children}
      </Group>
    </Group>
  );
}

// Команду копируют в терминал, поэтому собираем её только из «безопасных» хоста и логина — те же
// правила проверяет сервер (validation.ts). Старые или подложные значения команду не дают
const SAFE_HOST = /^[\p{L}\p{N}[][\p{L}\p{N}.:\-\]]*$/u;
const SAFE_USER = /^[A-Za-z0-9._+@][A-Za-z0-9._+@-]*$/;

function sshCommand(c: Credential, fallbackHost?: string | null) {
  const host = c.address || fallbackHost;
  if (!host || !SAFE_HOST.test(host) || (c.username && !SAFE_USER.test(c.username))) return null;
  const tool = c.kind === 'sftp' ? 'sftp' : 'ssh';
  const portFlag = c.port && c.port !== 22 ? (tool === 'sftp' ? ` -P ${c.port}` : ` -p ${c.port}`) : '';
  return `${tool}${portFlag} ${c.username ? `${c.username}@` : ''}${host}`;
}

function CredentialItem({
  c,
  fallbackHost,
  onEdit,
}: {
  c: Credential;
  fallbackHost?: string | null;
  onEdit: () => void;
}) {
  const { canInfra } = useAuth();
  const qc = useQueryClient();
  const [secret, setSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Открытый пароль сам скрывается через 30 секунд
  useEffect(() => {
    if (!secret) return;
    const t = setTimeout(() => setSecret(null), 30_000);
    return () => clearTimeout(t);
  }, [secret]);

  const fetchSecret = async () => {
    setLoading(true);
    try {
      return (await api.post<{ secret: string }>(`/api/credentials/${c.id}/reveal`)).secret;
    } catch (e) {
      notifications.show({ color: 'red', message: e instanceof ApiError ? e.message : 'Не удалось получить пароль' });
      return null;
    } finally {
      setLoading(false);
    }
  };

  const toggleReveal = async () => {
    if (secret) return setSecret(null);
    setSecret(await fetchSecret());
  };

  const copySecret = async () => {
    const value = secret ?? (await fetchSecret());
    if (!value) return;
    await navigator.clipboard.writeText(value);
    notifications.show({ color: 'teal', message: 'Пароль скопирован в буфер обмена' });
  };

  const remove = () =>
    modals.openConfirmModal({
      title: 'Удалить доступ?',
      children: <Text size="sm">Доступ «{c.title || kindLabels[c.kind as CredentialKind]}» будет удалён без возможности восстановления.</Text>,
      confirmProps: { color: 'red' },
      labels: { confirm: 'Удалить', cancel: 'Отмена' },
      onConfirm: async () => {
        await api.del(`/api/credentials/${c.id}`);
        qc.invalidateQueries({ queryKey: ['credentials', c.entityType, c.entityId] });
      },
    });

  const kind = c.kind as CredentialKind;
  const cmd = kind === 'ssh' || kind === 'sftp' ? sshCommand(c, fallbackHost) : null;
  const isKey = secret?.includes('PRIVATE KEY');

  return (
    <Card withBorder padding="sm">
      <Group justify="space-between" mb="xs" wrap="nowrap">
        <Group gap="xs" style={{ minWidth: 0 }}>
          <Badge color={kindColors[kind]} variant="light">
            {kindLabels[kind] ?? kind}
          </Badge>
          {c.title && (
            <Text fw={500} size="sm" truncate>
              {c.title}
            </Text>
          )}
        </Group>
        <Group gap={2} wrap="nowrap">
          {c.passworkUrl && (
            <Tooltip label="Открыть в Passwork">
              <ActionIcon component="a" href={c.passworkUrl} target="_blank" rel="noreferrer" variant="subtle" color="gray" size="sm">
                <IconKey size={15} />
              </ActionIcon>
            </Tooltip>
          )}
          {canInfra('edit') && (
            <>
              <ActionIcon variant="subtle" color="gray" size="sm" onClick={onEdit} aria-label="Изменить">
                <IconPencil size={15} />
              </ActionIcon>
              <ActionIcon variant="subtle" color="red" size="sm" onClick={remove} aria-label="Удалить">
                <IconTrash size={15} />
              </ActionIcon>
            </>
          )}
        </Group>
      </Group>

      <Stack gap={4}>
        {c.address && (
          <Row label={isWebKind(kind) ? 'Ссылка' : 'Хост'}>
            {isWebKind(kind) && /^https?:\/\//.test(c.address) ? (
              <Anchor href={c.address} target="_blank" rel="noreferrer" size="sm" truncate>
                {c.address} <IconExternalLink size={12} />
              </Anchor>
            ) : (
              <Text size="sm" className="mono" truncate>
                {c.address}
                {c.port ? `:${c.port}` : ''}
              </Text>
            )}
            <CopyIcon value={c.address} />
          </Row>
        )}
        {!c.address && c.port && (
          <Row label="Порт">
            <Text size="sm" className="mono">
              {c.port}
            </Text>
          </Row>
        )}
        {c.username && (
          <Row label="Логин">
            <Text size="sm" className="mono" truncate>
              {c.username}
            </Text>
            <CopyIcon value={c.username} />
          </Row>
        )}
        {c.hasSecret && (
          <Row label="Пароль">
            {secret && isKey ? (
              <Code block style={{ maxHeight: 160, overflow: 'auto', flex: 1, fontSize: 11 }}>
                {secret}
              </Code>
            ) : (
              <Text size="sm" className="mono" truncate style={{ userSelect: secret ? 'text' : 'none' }}>
                {secret ?? '••••••••••••'}
              </Text>
            )}
            {canInfra('edit') ? (
              <>
                <Tooltip label={secret ? 'Скрыть' : 'Показать'}>
                  <ActionIcon variant="subtle" color="gray" size="sm" loading={loading} onClick={toggleReveal}>
                    {secret ? <IconEyeOff size={14} /> : <IconEye size={14} />}
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Скопировать пароль">
                  <ActionIcon variant="subtle" color="gray" size="sm" onClick={copySecret}>
                    <IconCopy size={14} />
                  </ActionIcon>
                </Tooltip>
              </>
            ) : (
              <Text size="xs" c="dimmed">
                (нет прав на просмотр)
              </Text>
            )}
          </Row>
        )}
        {cmd && (
          <Row label="Команда">
            <IconTerminal2 size={14} style={{ flexShrink: 0 }} />
            {/* Целиком, без многоточия: копируют то, что видно */}
            <Text size="sm" className="mono" style={{ wordBreak: 'break-all' }}>
              {cmd}
            </Text>
            <CopyIcon value={cmd} label="Скопировать команду" />
          </Row>
        )}
        {c.notes && (
          <Text size="xs" c="dimmed" style={{ whiteSpace: 'pre-wrap' }} mt={4}>
            {c.notes}
          </Text>
        )}
      </Stack>
    </Card>
  );
}

interface CredentialFormValues extends CredentialDraft {
  title: string;
  clearSecret: boolean;
  notes: string;
}

function CredentialForm({
  entityType,
  entityId,
  defaultKind,
  credential,
  onDone,
}: {
  entityType: EntityType;
  entityId: number;
  defaultKind: CredentialKind;
  credential: Credential | null;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [keyMode, setKeyMode] = useState(false);
  const form = useForm<CredentialFormValues>({
    initialValues: {
      kind: (credential?.kind as CredentialKind) ?? defaultKind,
      title: credential?.title ?? '',
      address: credential?.address ?? '',
      port: credential?.port ?? defaultPorts[defaultKind] ?? '',
      username: credential?.username ?? '',
      secret: '',
      clearSecret: false,
      passworkUrl: credential?.passworkUrl ?? '',
      notes: credential?.notes ?? '',
    },
  });

  const save = useMutation({
    mutationFn: (v: CredentialFormValues) => {
      const payload = {
        ...credentialBody(v),
        title: v.title,
        notes: v.notes,
        ...(credential && v.clearSecret && !v.secret ? { clearSecret: true } : {}),
      };
      return credential
        ? api.patch(`/api/credentials/${credential.id}`, payload)
        : api.post('/api/credentials', { ...payload, entityType, entityId });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['credentials', entityType, entityId] });
      onDone();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fields) form.setErrors(e.fields);
      notifications.show({ color: 'red', title: 'Не удалось сохранить', message: e.message });
    },
  });

  const kind = form.values.kind;
  const sshLike = kind === 'ssh' || kind === 'sftp';

  return (
    <form onSubmit={form.onSubmit((v) => save.mutate(v))}>
      <Stack>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <Select
            label="Тип"
            data={Object.entries(kindLabels).map(([value, label]) => ({ value, label }))}
            allowDeselect={false}
            {...form.getInputProps('kind')}
            onChange={(v) => {
              const k = (v ?? 'other') as CredentialKind;
              form.setFieldValue('kind', k);
              if (!form.values.port || Object.values(defaultPorts).includes(Number(form.values.port))) {
                form.setFieldValue('port', defaultPorts[k] ?? '');
              }
            }}
          />
          <TextInput label="Название" placeholder="Например: root или основной" {...form.getInputProps('title')} />
        </SimpleGrid>
        <Group align="flex-start" wrap="nowrap">
          <TextInput
            label={isWebKind(kind) ? 'Ссылка' : 'Хост'}
            placeholder={isWebKind(kind) ? 'https://…' : sshLike ? 'Пусто = IP сервера' : 'host'}
            style={{ flex: 1 }}
            {...form.getInputProps('address')}
          />
          <NumberInput label="Порт" w={110} min={1} max={65535} allowDecimal={false} {...form.getInputProps('port')} />
        </Group>
        <TextInput label="Логин" autoComplete="off" {...form.getInputProps('username')} />
        {keyMode ? (
          <Textarea
            label="Приватный ключ"
            autosize
            minRows={4}
            maxRows={10}
            styles={{ input: { fontFamily: 'monospace', fontSize: 12 } }}
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
            {...form.getInputProps('secret')}
          />
        ) : (
          <PasswordInput
            label={kind === 'api' ? 'Токен' : 'Пароль'}
            autoComplete="new-password"
            placeholder={credential?.hasSecret ? 'Сохранён. Оставьте пустым, чтобы не менять' : ''}
            {...form.getInputProps('secret')}
          />
        )}
        <Group justify="space-between">
          {sshLike ? (
            <Anchor component="button" type="button" size="xs" onClick={() => setKeyMode((m) => !m)}>
              {keyMode ? 'Ввести пароль' : 'Вставить приватный ключ вместо пароля'}
            </Anchor>
          ) : (
            <span />
          )}
          {credential?.hasSecret && (
            <Checkbox size="xs" label="Удалить сохранённый пароль" {...form.getInputProps('clearSecret', { type: 'checkbox' })} />
          )}
        </Group>
        <TextInput
          label="Ссылка на запись в Passwork"
          placeholder="https://passwork…"
          description="Необязательно. Можно хранить пароль в Passwork, а здесь только ссылку"
          {...form.getInputProps('passworkUrl')}
        />
        <Textarea label="Заметки" autosize minRows={2} {...form.getInputProps('notes')} />
        <FormFooter onCancel={onDone} type="submit" loading={save.isPending}>
          Сохранить
        </FormFooter>
      </Stack>
    </form>
  );
}

export function CredentialsCard({
  entityType,
  entityId,
  defaultKind,
  fallbackHost,
}: {
  entityType: EntityType;
  entityId: number;
  defaultKind: CredentialKind;
  fallbackHost?: string | null;
}) {
  const { canInfra } = useAuth();
  const [editing, setEditing] = useState<Credential | 'new' | null>(null);
  const list = useQuery({
    queryKey: ['credentials', entityType, entityId],
    queryFn: () => api.get<Credential[]>(`/api/credentials?entityType=${entityType}&entityId=${entityId}`),
  });

  return (
    <Card withBorder>
      <Group justify="space-between" mb="sm">
        <Title order={4}>Доступы</Title>
        {canInfra('edit') && (
          <Button size="xs" variant="light" leftSection={<IconPlus size={14} />} onClick={() => setEditing('new')}>
            Добавить
          </Button>
        )}
      </Group>
      <Stack gap="sm">
        {list.data?.map((c) => (
          <CredentialItem key={c.id} c={c} fallbackHost={fallbackHost} onEdit={() => setEditing(c)} />
        ))}
        {list.data?.length === 0 && (
          <Text size="sm" c="dimmed">
            Доступов пока нет
          </Text>
        )}
      </Stack>
      <Modal
        opened={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Новый доступ' : 'Изменить доступ'}
        size="lg"
      >
        {editing !== null && (
          <CredentialForm
            entityType={entityType}
            entityId={entityId}
            defaultKind={defaultKind}
            credential={editing === 'new' ? null : editing}
            onDone={() => setEditing(null)}
          />
        )}
      </Modal>
    </Card>
  );
}
