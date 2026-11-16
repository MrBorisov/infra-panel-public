import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  Group,
  Menu,
  Modal,
  PasswordInput,
  SimpleGrid,
  Stack,
  Switch,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from '@mantine/core';
import { modals } from '@mantine/modals';
import { notifications } from '@mantine/notifications';
import { IconBrandDiscord, IconBrandTelegram, IconPencil, IconPlus, IconSend, IconTrash, IconWebhook } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import type { ChannelKind, NotificationsSettings, NotifyChannel } from '../../shared/types';
import { api } from '../api';
import { useAuth } from '../auth';
import { FormFooter } from '../components/FormFooter';
import { fromNow } from '../format';

function TelegramCard({ s }: { s: NotificationsSettings }) {
  const { refreshMe } = useAuth();
  const qc = useQueryClient();
  const [waiting, setWaiting] = useState(false);

  // Ждём, пока бот подтвердит привязку: обновляем данные раз в 3 секунды
  useEffect(() => {
    if (!waiting) return;
    if (s.telegram.linked) {
      setWaiting(false);
      notifications.show({ color: 'teal', message: 'Telegram привязан' });
      return;
    }
    const t = setInterval(() => qc.invalidateQueries({ queryKey: ['notifications'] }), 3000);
    const stop = setTimeout(() => setWaiting(false), 15 * 60_000);
    return () => {
      clearInterval(t);
      clearTimeout(stop);
    };
  }, [waiting, s.telegram.linked, qc]);

  const link = useMutation({
    mutationFn: () => api.post<{ deepLink: string }>('/api/me/telegram/link'),
    onSuccess: ({ deepLink }) => {
      window.open(deepLink, '_blank', 'noopener');
      setWaiting(true);
    },
    onError: (e) => notifications.show({ color: 'red', message: e.message }),
  });
  const unlink = useMutation({
    mutationFn: () => api.post('/api/me/telegram/unlink'),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      refreshMe();
    },
  });
  const test = useMutation({
    mutationFn: () => api.post('/api/me/telegram/test'),
    onSuccess: () => notifications.show({ color: 'teal', message: 'Сообщение в очереди — бот отправит его в течение минуты' }),
    onError: (e) => notifications.show({ color: 'red', message: e.message }),
  });

  return (
    <Card withBorder>
      <Group gap="xs" mb="sm">
        <IconBrandTelegram size={22} color="#229ED9" />
        <Title order={4}>Мой Telegram</Title>
      </Group>
      {!s.telegram.botConfigured ? (
        <Text size="sm" c="dimmed">
          Telegram-бот не настроен администратором системы.
        </Text>
      ) : s.telegram.linked ? (
        <Group>
          <Badge color="teal" variant="light" size="lg">
            привязан{s.telegram.username ? ` @${s.telegram.username}` : ''}
          </Badge>
          <Button variant="default" size="xs" leftSection={<IconSend size={14} />} onClick={() => test.mutate()} loading={test.isPending}>
            Тестовое сообщение
          </Button>
          <Button variant="subtle" color="red" size="xs" onClick={() => unlink.mutate()}>
            Отвязать
          </Button>
        </Group>
      ) : (
        <Stack gap="xs" align="flex-start">
          <Text size="sm" c="dimmed">
            Оповещения приходят лично вам — по всем пространствам, где вы участник, и только по темам, на которые есть права.
          </Text>
          <Button leftSection={<IconBrandTelegram size={16} />} onClick={() => link.mutate()} loading={link.isPending || waiting}>
            {waiting ? 'Ждём подтверждения в боте…' : 'Привязать Telegram'}
          </Button>
          {waiting && (
            <Text size="xs" c="dimmed">
              В открывшемся чате нажмите «Start». Ссылка действует 15 минут.
            </Text>
          )}
        </Stack>
      )}
    </Card>
  );
}

function MyTopicsCard({ s }: { s: NotificationsSettings }) {
  const qc = useQueryClient();
  const save = useMutation({
    mutationFn: (topics: string[]) => api.put('/api/notifications/my-topics', { topics }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const toggle = (key: string, on: boolean) => save.mutate(on ? [...s.myTopics, key] : s.myTopics.filter((t) => t !== key));
  return (
    <Card withBorder>
      <Title order={4} mb={4}>
        Что присылать мне в Telegram
      </Title>
      <Text size="xs" c="dimmed" mb="sm">
        Только для этого пространства
      </Text>
      <Stack gap="xs">
        {s.topics.map((t) => (
          <Checkbox key={t.key} label={topicLabel(t)} checked={s.myTopics.includes(t.key)} onChange={(e) => toggle(t.key, e.currentTarget.checked)} />
        ))}
      </Stack>
    </Card>
  );
}

/** Подпись темы в настройках: у тем модулей — с названием модуля («Модуль: Тема») */
const topicLabel = (t: NotificationsSettings['topics'][number]) => (t.module === 'infra' ? t.label : `${t.group}: ${t.label}`);

const KIND_META: Record<ChannelKind, { label: string; icon: ReactNode }> = {
  telegram_bot: { label: 'Свой Telegram-бот', icon: <IconBrandTelegram size={18} color="#229ED9" /> },
  discord_bot: { label: 'Свой Discord-бот', icon: <IconBrandDiscord size={18} color="#5865F2" /> },
  discord_webhook: { label: 'Discord-вебхук', icon: <IconWebhook size={18} color="#5865F2" /> },
};

/** Подсказки, где взять токен и адрес — у каждого вида свои */
const KIND_HELP: Record<ChannelKind, { secretLabel: string; secretHint: string; targetLabel?: string; targetHint?: string; targetPlaceholder?: string }> = {
  telegram_bot: {
    secretLabel: 'Токен бота',
    secretHint: '@BotFather → /newbot (или /mybots → API Token). Вид: 123456789:AAE…',
    targetLabel: 'Chat ID',
    targetPlaceholder: '-1001234567890 или @mychannel',
    targetHint: 'Добавьте бота в группу или канал (в канал — админом). ID группы: перешлите оттуда сообщение боту @getidsbot. Для публичного канала можно указать @имя',
  },
  discord_bot: {
    secretLabel: 'Токен бота',
    secretHint: 'discord.com/developers → ваше приложение → Bot → Reset Token. Пригласите бота на сервер с правами View Channel, Send Messages, Embed Links',
    targetLabel: 'ID канала',
    targetPlaceholder: '112233445566778899',
    targetHint: 'В Discord включите режим разработчика (Настройки → Расширенные), затем ПКМ по каналу → «Копировать ID»',
  },
  discord_webhook: {
    secretLabel: 'Ссылка вебхука',
    secretHint: 'Настройки канала → Интеграции → Вебхуки → Скопировать URL',
  },
};

interface ChannelForm {
  id?: number;
  kind: ChannelKind;
  name: string;
  secret: string;
  target: string;
  topics: string[];
}

function ChannelModal({ s, edit, onClose }: { s: NotificationsSettings; edit: ChannelForm; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<ChannelForm>(edit);
  const help = KIND_HELP[form.kind];
  const save = useMutation({
    mutationFn: () =>
      form.id
        ? api.patch(`/api/channels/${form.id}`, {
            name: form.name,
            topics: form.topics,
            ...(form.secret ? { secret: form.secret } : {}),
            ...(help.targetLabel ? { target: form.target } : {}),
          })
        : api.post('/api/channels', { ...form, target: help.targetLabel ? form.target : null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      onClose();
    },
    onError: (e) => notifications.show({ color: 'red', message: e.message }),
  });
  return (
    <Stack>
      <TextInput label="Название" placeholder="Например: алерты корпы" value={form.name} onChange={(e) => setForm({ ...form, name: e.currentTarget.value })} data-autofocus />
      <PasswordInput
        label={help.secretLabel}
        description={help.secretHint}
        placeholder={form.id ? 'Сохранён. Оставьте пустым, чтобы не менять' : undefined}
        value={form.secret}
        onChange={(e) => setForm({ ...form, secret: e.currentTarget.value })}
        autoComplete="off"
      />
      {help.targetLabel && (
        <TextInput
          label={help.targetLabel}
          description={help.targetHint}
          placeholder={help.targetPlaceholder}
          value={form.target}
          onChange={(e) => setForm({ ...form, target: e.currentTarget.value })}
        />
      )}
      <Text size="sm" fw={500}>
        Темы
      </Text>
      <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="xs">
        {s.topics.map((t) => (
          <Checkbox
            key={t.key}
            label={topicLabel(t)}
            checked={form.topics.includes(t.key)}
            onChange={(e) => setForm({ ...form, topics: e.currentTarget.checked ? [...form.topics, t.key] : form.topics.filter((x) => x !== t.key) })}
          />
        ))}
      </SimpleGrid>
      <FormFooter
        onCancel={onClose}
        onClick={() => save.mutate()}
        loading={save.isPending}
        disabled={!form.name.trim() || (!form.id && !form.secret.trim()) || (!!help.targetLabel && !form.target.trim()) || !form.topics.length}
      >
        Сохранить
      </FormFooter>
    </Stack>
  );
}

function ChannelStatus({ c }: { c: NotifyChannel }) {
  // Ошибка свежее успешной отправки — показываем её
  if (c.lastError && (!c.lastSentAt || (c.lastErrorAt ?? 0) > c.lastSentAt)) {
    return (
      <Tooltip label={c.lastError} multiline maw={360}>
        <Text size="xs" c="red" lineClamp={1}>
          ошибка {fromNow(c.lastErrorAt)}: {c.lastError}
        </Text>
      </Tooltip>
    );
  }
  if (c.lastSentAt) {
    return (
      <Text size="xs" c="teal">
        отправлено {fromNow(c.lastSentAt)}
      </Text>
    );
  }
  return (
    <Text size="xs" c="dimmed">
      ещё не отправлялось
    </Text>
  );
}

function ChannelsCard({ s }: { s: NotificationsSettings }) {
  const qc = useQueryClient();
  const [opened, setOpened] = useState(false);
  // Форма живёт и после закрытия — иначе окно на время анимации пустеет
  const [form, setForm] = useState<ChannelForm | null>(null);
  const setEdit = (f: ChannelForm | null) => {
    if (f) setForm(f);
    setOpened(!!f);
  };
  // На бейджах канала — короткая подпись темы, без названия модуля
  const labels = new Map(s.topics.map((t) => [t.key, t.label]));
  const defaultTopics = s.topics.filter((t) => t.channelDefault).map((t) => t.key);
  const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] });

  const toggle = async (id: number, enabled: boolean) => {
    await api.patch(`/api/channels/${id}`, { enabled });
    refresh();
  };
  const test = async (id: number) => {
    await api.post(`/api/channels/${id}/test`);
    notifications.show({ color: 'teal', message: 'Тестовое сообщение в очереди — итог появится у канала в течение минуты' });
    // Бот забирает очередь раз в 10–30 секунд
    setTimeout(refresh, 20_000);
    setTimeout(refresh, 45_000);
  };
  const remove = (c: NotifyChannel) =>
    modals.openConfirmModal({
      title: `Удалить канал «${c.name}»?`,
      children: <Text size="sm">Токен удалится из панели, неотправленные сообщения канала — тоже.</Text>,
      confirmProps: { color: 'red' },
      labels: { confirm: 'Удалить', cancel: 'Отмена' },
      onConfirm: async () => {
        await api.del(`/api/channels/${c.id}`);
        refresh();
      },
    });
  const start = (kind: ChannelKind) => setEdit({ kind, name: '', secret: '', target: '', topics: defaultTopics.length ? defaultTopics : s.topics.map((t) => t.key) });

  return (
    <Card withBorder>
      <Group justify="space-between" mb="sm">
        <div>
          <Title order={4}>Каналы пространства</Title>
          <Text size="xs" c="dimmed">
            Свои боты и вебхуки — например, рабочий чат или канал команды
          </Text>
        </div>
        <Menu position="bottom-end">
          <Menu.Target>
            <Button size="xs" variant="light" leftSection={<IconPlus size={14} />}>
              Добавить канал
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            {(Object.keys(KIND_META) as ChannelKind[]).map((k) => (
              <Menu.Item key={k} leftSection={KIND_META[k].icon} onClick={() => start(k)}>
                {KIND_META[k].label}
              </Menu.Item>
            ))}
          </Menu.Dropdown>
        </Menu>
      </Group>

      {(!s.bridge.telegram || !s.bridge.discord) && (
        <Alert color="gray" mb="sm">
          Отправку делает бот-посредник на зарубежной VDS (из РФ API Telegram и Discord недоступны).
          {!s.bridge.telegram && ' Мост Telegram не настроен (TG_BOT_API_TOKEN) — сообщения в Telegram будут ждать в очереди.'}
          {!s.bridge.discord && ' Мост Discord не настроен (BOT_API_TOKEN) — сообщения в Discord будут ждать в очереди.'}
        </Alert>
      )}

      {s.channels.length === 0 ? (
        <Text size="sm" c="dimmed">
          Каналов пока нет. Добавьте своего Telegram- или Discord-бота, чтобы тревоги приходили в общий чат.
        </Text>
      ) : (
        <Table.ScrollContainer minWidth={640}>
          <Table verticalSpacing="sm">
            <Table.Tbody>
              {s.channels.map((c) => (
                <Table.Tr key={c.id} opacity={c.enabled ? 1 : 0.55}>
                  <Table.Td>
                    <Group gap="xs" wrap="nowrap">
                      <Tooltip label={KIND_META[c.kind].label}>{KIND_META[c.kind].icon}</Tooltip>
                      <div style={{ minWidth: 0 }}>
                        <Text size="sm" fw={500}>
                          {c.name}
                        </Text>
                        <Text size="xs" c="dimmed" className="mono" truncate>
                          {c.where}
                        </Text>
                        <ChannelStatus c={c} />
                      </div>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <Group gap={4}>
                      {c.topics.map((t) => (
                        <Badge key={t} size="xs" variant="light" tt="none">
                          {labels.get(t) ?? t}
                        </Badge>
                      ))}
                    </Group>
                  </Table.Td>
                  <Table.Td w={170}>
                    <Group gap={4} wrap="nowrap" justify="flex-end">
                      <Tooltip label={c.enabled ? 'Выключить' : 'Включить'}>
                        <Switch size="xs" checked={c.enabled} onChange={(e) => toggle(c.id, e.currentTarget.checked)} />
                      </Tooltip>
                      <Tooltip label="Тестовое сообщение">
                        <ActionIcon variant="subtle" color="gray" onClick={() => test(c.id)}>
                          <IconSend size={15} />
                        </ActionIcon>
                      </Tooltip>
                      <ActionIcon
                        variant="subtle"
                        color="gray"
                        onClick={() => setEdit({ id: c.id, kind: c.kind, name: c.name, secret: '', target: c.target ?? '', topics: c.topics })}
                      >
                        <IconPencil size={15} />
                      </ActionIcon>
                      <ActionIcon variant="subtle" color="red" onClick={() => remove(c)}>
                        <IconTrash size={15} />
                      </ActionIcon>
                    </Group>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Table.ScrollContainer>
      )}
      {s.queue && (s.queue.telegramPending > 20 || s.queue.discordPending > 20) && (
        <Alert color="orange" mt="sm">
          В очереди скопились сообщения (Telegram: {s.queue.telegramPending}, Discord: {s.queue.discordPending}). Похоже, бот на VDS не забирает их — проверьте, что он запущен.
        </Alert>
      )}
      <Modal opened={opened} onClose={() => setEdit(null)} title={form ? `${form.id ? 'Канал' : 'Новый канал'}: ${KIND_META[form.kind].label}` : ''} size="lg">
        {form && <ChannelModal key={`${form.kind}-${form.id ?? 'new'}-${opened}`} s={s} edit={form} onClose={() => setEdit(null)} />}
      </Modal>
    </Card>
  );
}

export function NotificationsPage() {
  const { ws } = useAuth();
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => api.get<NotificationsSettings>('/api/notifications') });
  const s = q.data;
  return (
    <Stack>
      <div>
        <Title order={2}>Оповещения</Title>
        <Text c="dimmed" size="sm">
          {ws.name}
        </Text>
      </div>
      {s && (
        <>
          <SimpleGrid cols={{ base: 1, md: 2 }}>
            <TelegramCard s={s} />
            <MyTopicsCard s={s} />
          </SimpleGrid>
          {s.canManageChannels && <ChannelsCard s={s} />}
        </>
      )}
    </Stack>
  );
}
