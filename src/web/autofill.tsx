import { Anchor, Text } from '@mantine/core';
import type { UseFormReturnType } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import type { Domain, EntityPath } from '../shared/types';
import { api } from './api';
import { useAuth } from './auth';
import type { Lookups } from './entities';
import { findPreset, hostFromInput, normalizeUrlInput, registrableDomain } from './providers';

export type FormValues = Record<string, unknown>;

const asciiHost = (host: string) => {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return host;
  }
};

async function resolve(host: string) {
  return (await api.get<{ addresses: string[] }>(`/api/tools/resolve?host=${encodeURIComponent(host)}`)).addresses;
}

/** Подсказки и автозаполнение в формах: по адресу сайта, hostname сервера, названию провайдера */
export function useAutofill(path: EntityPath, form: UseFormReturnType<FormValues>, lookups: Lookups) {
  const { canInfra } = useAuth();
  const qc = useQueryClient();
  const [hints, setHints] = useState<Record<string, ReactNode>>({});
  const hint = (field: string, node: ReactNode) => setHints((h) => ({ ...h, [field]: node }));
  const v = (name: string) => form.getValues()[name];

  const createDomain = async (name: string) => {
    try {
      const created = await api.post<Domain>('/api/domains', { name });
      qc.setQueryData<Domain[]>(['domains'], (old) => [...(old ?? []), created]);
      qc.invalidateQueries({ queryKey: ['domains'] });
      form.setFieldValue('domainId', String(created.id));
      hint('domainId', <Text size="xs" c="teal">Домен {created.name} создан, срок подтянется автоматически</Text>);
    } catch (e) {
      notifications.show({ color: 'red', message: e instanceof Error ? e.message : 'Не удалось создать домен' });
    }
  };

  const onSiteUrlBlur = async () => {
    const raw = String(v('url') ?? '').trim();
    if (!raw) return;
    const url = normalizeUrlInput(raw);
    if (url !== raw) form.setFieldValue('url', url);
    const host = hostFromInput(raw);
    if (!host) return;
    const bare = host.replace(/^www\./, '');
    if (!v('name')) form.setFieldValue('name', bare);

    if (!v('domainId')) {
      // Самое длинное совпадение: для shop.example.com подойдёт example.com
      const ascii = asciiHost(bare);
      const match = lookups.lists.domains
        .filter((d) => [bare, ascii].some((h) => h === d.name || h.endsWith(`.${d.name}`) || h === asciiHost(d.name) || h.endsWith(`.${asciiHost(d.name)}`)))
        .sort((a, b) => b.name.length - a.name.length)[0];
      if (match) {
        form.setFieldValue('domainId', String(match.id));
        hint('domainId', <Text size="xs" c="teal">Подобран по адресу сайта</Text>);
      } else if (canInfra('edit')) {
        const suggestion = registrableDomain(bare);
        hint(
          'domainId',
          <Text size="xs">
            Домена {suggestion} ещё нет в панели.{' '}
            <Anchor component="button" type="button" size="xs" onClick={() => createDomain(suggestion)}>
              Добавить
            </Anchor>
          </Text>,
        );
      }
    }

    if (!v('serverId') && !v('hostingId')) {
      const addresses = await resolve(host).catch((): string[] => []);
      const server = lookups.lists.servers.find((s) => s.ip && addresses.includes(s.ip));
      if (server) {
        form.setFieldValue('placementType', 'server');
        form.setFieldValue('serverId', String(server.id));
        hint('placement', <Text size="xs" c="teal">Определён по DNS: {host} → {server.ip}</Text>);
      } else if (addresses.length) {
        hint('placement', <Text size="xs" c="dimmed">{host} указывает на {addresses.slice(0, 3).join(', ')}. Сервера с таким IP в панели нет</Text>);
      }
    }
  };

  const onServerHostnameBlur = async () => {
    const host = hostFromInput(String(v('hostname') ?? ''));
    if (!host || v('ip')) return;
    const addresses = await resolve(host).catch((): string[] => []);
    const ipv4 = addresses.find((a) => a.includes('.')) ?? addresses[0];
    if (ipv4) {
      form.setFieldValue('ip', ipv4);
      hint('ip', <Text size="xs" c="teal">Определён по DNS</Text>);
    }
  };

  const onDomainNameBlur = () => {
    const raw = String(v('name') ?? '');
    const host = hostFromInput(raw).replace(/^www\./, '');
    if (host && host !== raw) form.setFieldValue('name', host);
  };

  const onProviderSelect = (provider: string) => {
    const preset = findPreset(provider);
    if (!preset) return;
    if (!v('url')) {
      form.setFieldValue('url', preset.url);
      hint('url', <Text size="xs" c="teal">Ссылка на ЛК {preset.name} подставлена автоматически</Text>);
    }
    if (!v('name')) form.setFieldValue('name', preset.name);
  };

  const onBlur: Record<string, () => void> = {};
  if (path === 'sites') onBlur.url = onSiteUrlBlur;
  if (path === 'servers') onBlur.hostname = onServerHostnameBlur;
  if (path === 'domains') onBlur.name = onDomainNameBlur;
  if (path === 'accounts') onBlur.provider = () => onProviderSelect(String(v('provider') ?? ''));

  const clearHint = (field: string) =>
    setHints((h) => {
      if (!(field in h)) return h;
      const { [field]: _, ...rest } = h;
      return rest;
    });

  return { hints, onBlur, onProviderSelect, clearHint, resetHints: () => setHints({}) };
}
