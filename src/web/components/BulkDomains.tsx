import { Alert, Badge, Button, Group, Modal, Progress, ScrollArea, SimpleGrid, Stack, Switch, Text, Textarea } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api } from '../api';
import { useLookups } from '../entities';
import { hostFromInput } from '../providers';
import { RefSelect } from './RefSelect';

const DOMAIN_RE = /^([\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]{2,}$/u;

type Parsed = { name: string; status: 'new' | 'exists' | 'invalid' };

/** Разбор вставленного текста: по строке, через запятую или пробел; ссылки и www обрезаются */
function parse(text: string, existing: Set<string>): Parsed[] {
  const seen = new Set<string>();
  const out: Parsed[] = [];
  for (const token of text.split(/[\s,;]+/)) {
    const name = hostFromInput(token).replace(/^www\./, '');
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, status: !DOMAIN_RE.test(name) ? 'invalid' : existing.has(name) ? 'exists' : 'new' });
  }
  return out;
}

const statusBadge: Record<Parsed['status'], { color: string; label: string }> = {
  new: { color: 'teal', label: 'новый' },
  exists: { color: 'gray', label: 'уже есть' },
  invalid: { color: 'red', label: 'ошибка' },
};

export function BulkDomainsModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const lookups = useLookups();
  const [text, setText] = useState('');
  const [registrar, setRegistrar] = useState<string | null>(null);
  const [dns, setDns] = useState<string | null>(null);
  const [autoRenew, setAutoRenew] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const existing = useMemo(() => new Set(lookups.lists.domains.map((d) => d.name)), [lookups.lists.domains]);
  const parsed = useMemo(() => parse(text, existing), [text, existing]);
  const toCreate = parsed.filter((p) => p.status === 'new');

  const close = () => {
    setText('');
    setErrors([]);
    setProgress(null);
    onClose();
  };

  const submit = async () => {
    setErrors([]);
    setProgress({ done: 0, total: toCreate.length });
    const failed: string[] = [];
    for (const [i, p] of toCreate.entries()) {
      try {
        await api.post('/api/domains', {
          name: p.name,
          registrarAccountId: registrar ? Number(registrar) : null,
          dnsAccountId: dns ? Number(dns) : null,
          autoRenew,
        });
      } catch (e) {
        failed.push(`${p.name}: ${e instanceof Error ? e.message : 'ошибка'}`);
      }
      setProgress({ done: i + 1, total: toCreate.length });
    }
    qc.invalidateQueries({ queryKey: ['domains'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
    const created = toCreate.length - failed.length;
    if (created) {
      notifications.show({ color: 'teal', message: `Добавлено доменов: ${created}. Сроки подтянутся автоматически в течение пары минут` });
    }
    if (failed.length) {
      setErrors(failed);
      setProgress(null);
    } else {
      close();
    }
  };

  return (
    <Modal opened={opened} onClose={close} title="Добавить домены списком" size="lg">
      <Stack>
        <Textarea
          label="Домены"
          description="По одному в строке, через запятую или пробел. Можно вставлять ссылки, лишнее отрежется"
          placeholder={'example.com\nexample.ru\nhttps://www.shop.example.org/'}
          autosize
          minRows={6}
          maxRows={12}
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          data-autofocus
        />
        <SimpleGrid cols={{ base: 1, xs: 2 }}>
          <RefSelect refPath="accounts" label="Регистратор для всех" placeholder="Выберите или введите новый" value={registrar} onChange={setRegistrar} />
          <RefSelect refPath="accounts" label="DNS для всех" placeholder="Если не у регистратора" value={dns} onChange={setDns} />
        </SimpleGrid>
        <Switch label="Автопродление включено" checked={autoRenew} onChange={(e) => setAutoRenew(e.currentTarget.checked)} />

        {parsed.length > 0 && (
          <ScrollArea.Autosize mah={180}>
            <Group gap={6}>
              {parsed.map((p) => (
                <Badge key={p.name} variant="light" color={statusBadge[p.status].color} tt="none" title={statusBadge[p.status].label}>
                  {p.name}
                  {p.status !== 'new' && ` · ${statusBadge[p.status].label}`}
                </Badge>
              ))}
            </Group>
          </ScrollArea.Autosize>
        )}

        {progress && <Progress value={(progress.done / Math.max(progress.total, 1)) * 100} animated />}

        {errors.length > 0 && (
          <Alert color="red" title="Не все домены добавлены">
            {errors.map((e) => (
              <Text key={e} size="sm">
                {e}
              </Text>
            ))}
          </Alert>
        )}

        <Group justify="space-between">
          <Text size="sm" c="dimmed">
            {parsed.length ? `Новых: ${toCreate.length} из ${parsed.length}` : ''}
          </Text>
          <Group gap="xs">
            <Button variant="default" onClick={close}>
              Отмена
            </Button>
            <Button onClick={submit} disabled={!toCreate.length} loading={!!progress}>
              Добавить {toCreate.length || ''}
            </Button>
          </Group>
        </Group>
      </Stack>
    </Modal>
  );
}
