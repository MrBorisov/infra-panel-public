import { Group, Kbd, Text, UnstyledButton } from '@mantine/core';
import { Spotlight, spotlight, type SpotlightActionGroupData } from '@mantine/spotlight';
import { IconPlus, IconSearch } from '@tabler/icons-react';
import { useNavigate } from 'react-router';
import type { Account, Domain, Server, Site } from '../../shared/types';
import { useAuth } from '../auth';
import { useCreate } from '../create';
import { entityConfigs, navOrder, useLookups } from '../entities';

/** Поиск по всем объектам и быстрые действия: Cmd+K или «/» */
export function GlobalSearch() {
  const { canInfra } = useAuth();
  const { openCreate } = useCreate();
  const navigate = useNavigate();
  const lookups = useLookups();

  const groups: SpotlightActionGroupData[] = [];
  if (canInfra('edit')) {
    groups.push({
      group: 'Добавить',
      actions: navOrder.map((path) => {
        const c = entityConfigs[path];
        const Icon = c.icon;
        return {
          id: `create-${path}`,
          label: `Добавить ${c.accusative}`,
          keywords: ['добавить', 'создать', 'новый', c.title],
          leftSection: <IconPlus size={18} />,
          rightSection: <Icon size={16} />,
          onClick: () => openCreate(path),
        };
      }),
    });
  }
  for (const path of navOrder) {
    const c = entityConfigs[path];
    const Icon = c.icon;
    const items = lookups.lists[path];
    if (!items.length) continue;
    groups.push({
      group: c.title,
      actions: items.map((x) => {
        const r = x as Partial<Server & Site & Domain & Account>;
        const description = r.ip || r.hostname || r.url || r.provider || undefined;
        return {
          id: `${path}-${x.id}`,
          label: x.name,
          description,
          keywords: [r.ip, r.hostname, r.url, r.provider, r.stack].filter(Boolean) as string[],
          leftSection: <Icon size={18} stroke={1.5} />,
          onClick: () => navigate(`/${path}/${x.id}`),
        };
      }),
    });
  }

  return (
    <Spotlight
      actions={groups}
      shortcut={['mod + K', '/']}
      nothingFound="Ничего не найдено"
      highlightQuery
      limit={30}
      scrollable
      maxHeight={480}
      searchProps={{ leftSection: <IconSearch size={18} stroke={1.5} />, placeholder: 'Сервер, сайт, домен, IP…' }}
    />
  );
}

export function SearchButton() {
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <UnstyledButton
      onClick={() => spotlight.open()}
      px="sm"
      py={6}
      w={{ base: 40, sm: 260 }}
      style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 'var(--mantine-radius-md)' }}
    >
      <Group gap="xs" justify="space-between" wrap="nowrap">
        <Group gap="xs" wrap="nowrap">
          <IconSearch size={16} color="var(--mantine-color-dimmed)" />
          <Text size="sm" c="dimmed" visibleFrom="sm">
            Поиск
          </Text>
        </Group>
        <Kbd size="xs" visibleFrom="sm">
          {isMac ? '⌘' : 'Ctrl'} K
        </Kbd>
      </Group>
    </UnstyledButton>
  );
}
