import { Button, Card, Center, Group, Stack, Table, Text, TextInput, Title } from '@mantine/core';
import { IconListDetails, IconPlus, IconSearch } from '@tabler/icons-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import type { EntityPath } from '../../shared/types';
import { useAuth } from '../auth';
import { listColumns, searchText } from '../columns';
import { BulkDomainsModal } from '../components/BulkDomains';
import { PageLoader } from '../components/PageState';
import { useCreate } from '../create';
import { entityConfigs, useLookups } from '../entities';

const emptyHints: Record<EntityPath, string> = {
  servers: 'Добавьте VPS: IP, аккаунт хостера, SSH-доступ и дату оплаты. Мониторинг включится сам.',
  sites: 'Достаточно вставить адрес сайта: домен и сервер подберутся автоматически.',
  domains: 'Вставьте список доменов, и сроки окончания подтянутся через RDAP/WHOIS.',
  hostings: 'Добавьте виртуальный хостинг: аккаунт провайдера, тариф и дату оплаты.',
  accounts: 'Аккаунты у провайдеров: регистраторы, хостеры, DNS. Ссылка на ЛК и доступ к нему.',
};

export function EntityListPage({ path }: { path: EntityPath }) {
  const config = entityConfigs[path];
  const { canInfra } = useAuth();
  const { openCreate } = useCreate();
  const navigate = useNavigate();
  const lookups = useLookups();
  const [search, setSearch] = useState('');
  const [bulk, setBulk] = useState(false);

  const columns = listColumns[path];
  const q = search.trim().toLowerCase();
  const all = lookups.lists[path];
  const rows = all.filter((r) => !q || searchText(r).includes(q));
  const Icon = config.icon;
  const canBulk = path === 'domains' && canInfra('edit');

  return (
    <Stack>
      <Group justify="space-between">
        <Group gap="xs">
          <Icon size={26} stroke={1.6} />
          <Title order={2}>{config.title}</Title>
          <Text c="dimmed">{all.length || ''}</Text>
        </Group>
        <Group gap="xs">
          {all.length > 0 && (
            <TextInput
              placeholder="Поиск"
              leftSection={<IconSearch size={16} />}
              value={search}
              onChange={(e) => setSearch(e.currentTarget.value)}
              w={{ base: '100%', xs: 220 }}
            />
          )}
          {canBulk && (
            <Button variant="default" leftSection={<IconListDetails size={16} />} onClick={() => setBulk(true)}>
              Добавить списком
            </Button>
          )}
          {canInfra('edit') && (
            <Button leftSection={<IconPlus size={16} />} onClick={() => openCreate(path)}>
              Добавить {config.accusative}
            </Button>
          )}
        </Group>
      </Group>

      <Card withBorder p={0}>
        {lookups.isPending ? (
          <PageLoader />
        ) : all.length === 0 ? (
          <Stack align="center" gap="sm" p="xl">
            <Icon size={40} stroke={1.2} color="var(--mantine-color-dimmed)" />
            <Text fw={500}>Пока пусто</Text>
            <Text c="dimmed" size="sm" ta="center" maw={420}>
              {emptyHints[path]}
            </Text>
            {canInfra('edit') && (
              <Group gap="xs" mt="xs">
                {canBulk && (
                  <Button variant="default" onClick={() => setBulk(true)}>
                    Вставить список
                  </Button>
                )}
                <Button leftSection={<IconPlus size={16} />} onClick={() => openCreate(path)}>
                  Добавить {config.accusative}
                </Button>
              </Group>
            )}
          </Stack>
        ) : rows.length === 0 ? (
          <Center p="xl">
            <Text c="dimmed">Ничего не найдено</Text>
          </Center>
        ) : (
          <Table.ScrollContainer minWidth={960}>
            <Table highlightOnHover verticalSpacing="sm">
              <Table.Thead>
                <Table.Tr>
                  {columns.map((c) => (
                    <Table.Th key={c.title} w={c.w}>
                      {c.title}
                    </Table.Th>
                  ))}
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {rows.map((row) => (
                  <Table.Tr key={row.id} style={{ cursor: 'pointer' }} onClick={() => navigate(`/${path}/${row.id}`)}>
                    {columns.map((c) => (
                      <Table.Td key={c.title}>{c.render(row, lookups)}</Table.Td>
                    ))}
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
          </Table.ScrollContainer>
        )}
      </Card>

      {canBulk && <BulkDomainsModal opened={bulk} onClose={() => setBulk(false)} />}
    </Stack>
  );
}
