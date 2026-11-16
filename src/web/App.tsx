import {
  ActionIcon,
  AppShell,
  Badge,
  Burger,
  Button,
  Divider,
  Group,
  Menu,
  NavLink,
  ScrollArea,
  Stack,
  Text,
  Tooltip,
  UnstyledButton,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core';
import { useDisclosure } from '@mantine/hooks';
import {
  IconBell,
  IconCheck,
  IconChevronDown,
  IconHistory,
  IconLayoutDashboard,
  IconLogout,
  IconMoon,
  IconPlus,
  IconPuzzle,
  IconServer2,
  IconSettings,
  IconShieldLock,
  IconSun,
  IconUsers,
  IconUsersGroup,
} from '@tabler/icons-react';
import { useState, type ReactNode } from 'react';
import { Link, Navigate, Route, Routes, useLocation } from 'react-router';
import { AuthGate, useAuth } from './auth';
import { GlobalSearch, SearchButton } from './components/GlobalSearch';
import { CreateWorkspaceModal } from './components/Workspaces';
import { CreateProvider, useCreate } from './create';
import { entityConfigs, navOrder } from './entities';
import { AuditPage } from './pages/Audit';
import { DashboardPage } from './pages/Dashboard';
import { EntityDetailPage } from './pages/EntityDetail';
import { EntityListPage } from './pages/EntityList';
import { InvitePage } from './pages/Invite';
import { MembersPage } from './pages/Members';
import { ModulesPage } from './pages/Modules';
import { NotificationsPage } from './pages/Notifications';
import { SettingsPage } from './pages/Settings';
import { UsersPage } from './pages/Users';
import { hasModuleLevel, modulesIn, webModules } from './modules';
import { useDashboard } from './queries';

function ColorSchemeToggle() {
  const { setColorScheme } = useMantineColorScheme();
  const scheme = useComputedColorScheme('light');
  return (
    <Tooltip label={scheme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}>
      <ActionIcon variant="subtle" color="gray" onClick={() => setColorScheme(scheme === 'dark' ? 'light' : 'dark')}>
        {scheme === 'dark' ? <IconSun size={18} /> : <IconMoon size={18} />}
      </ActionIcon>
    </Tooltip>
  );
}

function AddMenu() {
  const { openCreate } = useCreate();
  return (
    <Menu position="bottom-end" width={200}>
      <Menu.Target>
        <Button leftSection={<IconPlus size={16} />} size="sm" px={{ base: 'xs', sm: 'md' }}>
          <Text span size="sm" fw={600} visibleFrom="sm">
            Добавить
          </Text>
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {navOrder.map((path) => {
          const c = entityConfigs[path];
          const Icon = c.icon;
          return (
            <Menu.Item key={path} leftSection={<Icon size={16} />} onClick={() => openCreate(path)}>
              {c.single}
            </Menu.Item>
          );
        })}
      </Menu.Dropdown>
    </Menu>
  );
}

/** Переключатель пространств: свои и те, куда пригласили */
function WorkspaceSwitcher() {
  const { ws, workspaces, switchWorkspace } = useAuth();
  const [creating, setCreating] = useState(false);
  return (
    <>
    <CreateWorkspaceModal opened={creating} onClose={() => setCreating(false)} />
    <Menu position="bottom-start" width={260}>
      <Menu.Target>
        <UnstyledButton
          px="sm"
          py={8}
          w="100%"
          style={{ border: '1px solid var(--mantine-color-default-border)', borderRadius: 'var(--mantine-radius-md)' }}
        >
          <Group justify="space-between" wrap="nowrap" gap="xs">
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text size="xs" c="dimmed">
                Пространство
              </Text>
              <Text size="sm" fw={600} truncate>
                {ws.name}
              </Text>
            </Stack>
            <IconChevronDown size={16} style={{ flexShrink: 0 }} />
          </Group>
        </UnstyledButton>
      </Menu.Target>
      <Menu.Dropdown>
        {workspaces.map((w) => (
          <Menu.Item key={w.id} onClick={() => switchWorkspace(w.id)} rightSection={w.id === ws.id ? <IconCheck size={14} /> : null}>
            <Text size="sm">{w.name}</Text>
            <Text size="xs" c="dimmed">
              {w.isOwner ? 'владелец' : [w.infra !== 'none' && 'инфраструктура', ...modulesIn(w).filter((m) => (w.modules[m.id] ?? 'none') !== 'none').map((m) => m.title)].filter(Boolean).join(' · ') || 'участник'}
            </Text>
          </Menu.Item>
        ))}
        <Menu.Divider />
        <Menu.Item leftSection={<IconPlus size={14} />} onClick={() => setCreating(true)}>
          Создать пространство
        </Menu.Item>
      </Menu.Dropdown>
    </Menu>
    </>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <Text size="xs" c="dimmed" fw={600} tt="uppercase" px="sm" mt="sm" mb={4}>
        {label}
      </Text>
      {children}
    </>
  );
}

function Shell() {
  const { user, ws, canInfra, isSysAdmin, logout } = useAuth();
  const [opened, { toggle, close }] = useDisclosure();
  const { pathname } = useLocation();
  const dashboard = useDashboard(canInfra('view'));
  // Модули: что открыто участнику и сколько требует внимания. Список модулей не меняется,
  // поэтому хуки useAttention вызываются в одном и том же порядке
  const modules = webModules().map((m) => {
    const visible = hasModuleLevel(ws, m.id, m.levels[1].value);
    return { m, visible, attention: m.useAttention?.(visible) ?? 0 };
  });

  const downCount = (type: 'server' | 'site') => dashboard.data?.down.filter((d) => d.type === type).length ?? 0;
  const urgentDeadlines = dashboard.data?.deadlines.filter((d) => d.daysLeft <= 7).length ?? 0;
  const moduleAlerts = modules.reduce((sum, x) => sum + (x.visible ? x.attention : 0), 0);

  const isActive = (to: string) => (to === '/' ? pathname === '/' : pathname === to || pathname.startsWith(`${to}/`));
  const navItem = (to: string, label: string, icon: ReactNode, badge?: number, badgeColor = 'red') => (
    <NavLink
      key={to}
      component={Link}
      to={to}
      label={label}
      leftSection={icon}
      active={isActive(to)}
      onClick={close}
      rightSection={badge ? <Badge size="sm" color={badgeColor} circle>{badge}</Badge> : null}
    />
  );

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 250, breakpoint: 'sm', collapsed: { mobile: !opened } }} padding="md">
      <AppShell.Header>
        <Group h="100%" px="md" justify="space-between">
          <Group gap="xs">
            <Burger opened={opened} onClick={toggle} hiddenFrom="sm" size="sm" />
            <IconServer2 size={24} stroke={1.6} color="var(--mantine-color-indigo-6)" />
            <Text fw={700}>Infra Panel</Text>
          </Group>
          <Group gap="xs" wrap="nowrap">
            {canInfra('view') && <SearchButton />}
            {canInfra('edit') && <AddMenu />}
            <ColorSchemeToggle />
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="xs">
        <AppShell.Section mb="xs">
          <WorkspaceSwitcher />
        </AppShell.Section>
        <AppShell.Section grow component={ScrollArea}>
          {navItem('/', 'Обзор', <IconLayoutDashboard size={18} />, urgentDeadlines + moduleAlerts, 'orange')}
          {canInfra('view') && (
            <Section label="Инфраструктура">
              {navOrder.map((path) => {
                const c = entityConfigs[path];
                const Icon = c.icon;
                const badge = path === 'servers' ? downCount('server') : path === 'sites' ? downCount('site') : 0;
                return navItem(`/${path}`, c.title, <Icon size={18} />, badge);
              })}
            </Section>
          )}
          {modules.map(
            ({ m, visible, attention }) =>
              visible && (
                <Section key={m.id} label={m.title}>
                  {(m.nav ?? [])
                    .filter((n) => hasModuleLevel(ws, m.id, n.level))
                    .map((n) => navItem(n.to, n.label, <m.icon size={18} />, n.badge ? attention : 0, 'orange'))}
                </Section>
              ),
          )}
          <Section label="Пространство">
            {ws.manageMembers && navItem('/members', 'Участники', <IconUsersGroup size={18} />)}
            {navItem('/notifications', 'Оповещения', <IconBell size={18} />)}
            {ws.manageMembers && navItem('/audit', 'Журнал', <IconHistory size={18} />)}
          </Section>
          {isSysAdmin && (
            <Section label="Система">
              {navItem('/users', 'Пользователи', <IconUsers size={18} />)}
              {navItem('/modules', 'Модули', <IconPuzzle size={18} />)}
              {navItem('/system-audit', 'Системный журнал', <IconShieldLock size={18} />)}
            </Section>
          )}
        </AppShell.Section>
        <AppShell.Section>
          <Divider my="xs" />
          {navItem('/settings', 'Настройки', <IconSettings size={18} />)}
          <Group justify="space-between" px="sm" py="xs" wrap="nowrap">
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text size="sm" fw={500} truncate>
                {user.name}
              </Text>
              <Text size="xs" c="dimmed" truncate>
                {ws.isOwner ? 'владелец пространства' : 'участник'}
              </Text>
            </Stack>
            <Tooltip label="Выйти">
              <ActionIcon variant="subtle" color="gray" onClick={logout} aria-label="Выйти">
                <IconLogout size={18} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </AppShell.Section>
      </AppShell.Navbar>

      <AppShell.Main>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          {canInfra('view') &&
            navOrder.map((path) => [
              <Route key={path} path={`/${path}`} element={<EntityListPage key={path} path={path} />} />,
              <Route key={`${path}-id`} path={`/${path}/:id`} element={<EntityDetailPage key={path} path={path} />} />,
            ])}
          {webModules().flatMap((m) =>
            (m.routes ?? []).filter((r) => hasModuleLevel(ws, m.id, r.level)).map((r) => <Route key={r.path} path={r.path} element={r.element} />),
          )}
          {ws.manageMembers && <Route path="/members" element={<MembersPage />} />}
          {ws.manageMembers && <Route path="/audit" element={<AuditPage scope="workspace" />} />}
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/invite/:token" element={<InvitePage />} />
          {isSysAdmin && <Route path="/users" element={<UsersPage />} />}
          {isSysAdmin && <Route path="/modules" element={<ModulesPage />} />}
          {isSysAdmin && <Route path="/system-audit" element={<AuditPage scope="system" />} />}
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell.Main>
      {canInfra('view') && <GlobalSearch />}
    </AppShell>
  );
}

export function App() {
  return (
    <AuthGate>
      <CreateProvider>
        <Shell />
      </CreateProvider>
    </AuthGate>
  );
}
