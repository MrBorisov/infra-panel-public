import { ActionIcon, Button, Card, Group, NumberInput, PasswordInput, Select, SimpleGrid, Stack, TextInput } from '@mantine/core';
import type { UseFormReturnType } from '@mantine/form';
import { IconPlus, IconX } from '@tabler/icons-react';
import type { CredentialKind, EntityType } from '../../shared/types';
import { api } from '../api';
import { credentialBody, defaultPorts, kindLabels, type CredentialDraft } from './credentialKinds';

const withPort = (k: CredentialKind) => k === 'ssh' || k === 'sftp' || k === 'ftp' || k === 'db';

export function newDraft(kind: CredentialKind): CredentialDraft {
  return { kind, address: '', port: defaultPorts[kind] ?? '', username: '', secret: '', passworkUrl: '' };
}

const isEmpty = (d: CredentialDraft) => !d.username.trim() && !d.secret && !d.address.trim() && !d.passworkUrl.trim();

function addressPlaceholder(kind: CredentialKind, entityType: EntityType) {
  if (kind === 'ssh' || kind === 'sftp') return entityType === 'server' ? 'Пусто = IP сервера' : 'Хост';
  if (kind === 'panel') return entityType === 'account' ? 'Пусто = ссылка на ЛК' : 'https://…';
  if (kind === 'admin') return 'https://example.com/wp-admin';
  return 'Хост или ссылка';
}

/** Сохраняет заполненные черновики доступов, пустые пропускает. Возвращает число ошибок */
export async function saveDrafts(drafts: CredentialDraft[], entityType: EntityType, entityId: number) {
  let failed = 0;
  for (const d of drafts.filter((x) => !isEmpty(x))) {
    try {
      await api.post('/api/credentials', { ...credentialBody(d), entityType, entityId });
    } catch {
      failed++;
    }
  }
  return failed;
}

/** Доступы прямо в форме создания: логин и пароль от ЛК, SSH и т. п. */
export function CredentialDrafts({
  form,
  entityType,
  defaultKind,
}: {
  form: UseFormReturnType<Record<string, unknown>>;
  entityType: EntityType;
  defaultKind: CredentialKind;
}) {
  const drafts = (form.getValues().credentials ?? []) as CredentialDraft[];
  const path = (i: number, field: keyof CredentialDraft) => `credentials.${i}.${field}`;

  return (
    <Stack gap="sm">
      {drafts.map((d, i) => (
        <Card key={i} withBorder padding="sm" bg="var(--mantine-color-default-hover)">
          <Stack gap="xs">
            <Group justify="space-between" wrap="nowrap">
              <Select
                size="xs"
                w={220}
                data={Object.entries(kindLabels).map(([value, label]) => ({ value, label }))}
                allowDeselect={false}
                {...form.getInputProps(path(i, 'kind'))}
                onChange={(v) => {
                  const k = (v ?? 'other') as CredentialKind;
                  form.setFieldValue(path(i, 'kind'), k);
                  form.setFieldValue(path(i, 'port'), defaultPorts[k] ?? '');
                }}
              />
              <ActionIcon variant="subtle" color="gray" onClick={() => form.removeListItem('credentials', i)} aria-label="Убрать доступ">
                <IconX size={16} />
              </ActionIcon>
            </Group>
            <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="xs">
              <TextInput
                label="Логин"
                autoComplete="off"
                placeholder={d.kind === 'ssh' ? 'root' : undefined}
                {...form.getInputProps(path(i, 'username'))}
              />
              <PasswordInput
                label={d.kind === 'api' ? 'Токен' : 'Пароль'}
                autoComplete="new-password"
                {...form.getInputProps(path(i, 'secret'))}
              />
            </SimpleGrid>
            <Group align="flex-start" wrap="nowrap" gap="xs">
              <TextInput
                label={d.kind === 'ssh' || d.kind === 'sftp' || d.kind === 'db' ? 'Хост' : 'Ссылка'}
                placeholder={addressPlaceholder(d.kind, entityType)}
                style={{ flex: 1 }}
                {...form.getInputProps(path(i, 'address'))}
              />
              {withPort(d.kind) && (
                <NumberInput label="Порт" w={90} min={1} max={65535} allowDecimal={false} hideControls {...form.getInputProps(path(i, 'port'))} />
              )}
            </Group>
            <TextInput
              size="xs"
              placeholder="Ссылка на запись в Passwork (необязательно)"
              {...form.getInputProps(path(i, 'passworkUrl'))}
            />
          </Stack>
        </Card>
      ))}
      <Button
        variant="subtle"
        size="xs"
        w="fit-content"
        leftSection={<IconPlus size={14} />}
        onClick={() => form.insertListItem('credentials', newDraft(drafts.length ? 'other' : defaultKind))}
      >
        {drafts.length ? 'Ещё доступ' : 'Добавить доступ'}
      </Button>
    </Stack>
  );
}
