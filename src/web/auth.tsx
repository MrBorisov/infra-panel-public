import {
  Alert,
  Anchor,
  Button,
  Center,
  Divider,
  List,
  Loader,
  Paper,
  PasswordInput,
  PinInput,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
  Title,
} from '@mantine/core';
import { useForm } from '@mantine/form';
import { IconAlertCircle, IconLogin, IconServer2 } from '@tabler/icons-react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { matchPath, useLocation, useNavigate } from 'react-router';
import type { AuthProvider, InfraAccess, MeResponse, ModuleLevels, SessionUser, SystemRole, WorkspaceAccess } from '../shared/types';
import { api, ApiError, getApiWorkspace, rememberWorkspace, setApiWorkspace, setUnauthorizedHandler } from './api';
import { hasModuleLevel, levelLabel, webModule, webModules } from './modules';

const INFRA_LEVEL: Record<InfraAccess, number> = { none: 0, view: 1, edit: 2 };

interface AuthValue {
  user: SessionUser;
  workspaces: WorkspaceAccess[];
  ws: WorkspaceAccess;
  switchWorkspace: (id: number) => Promise<void>;
  canInfra: (level: 'view' | 'edit') => boolean;
  /** Уровень в модуле не ниже level (модуль выключен в пространстве — нет) */
  canModule: (id: string, level: string) => boolean;
  isSysAdmin: boolean;
  refreshMe: () => Promise<unknown>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth вне AuthGate');
  return ctx;
}

export const systemRoleLabels: Record<SystemRole, string> = { admin: 'Администратор системы', user: 'Пользователь' };
export const infraLabels: Record<InfraAccess, string> = { none: 'Нет доступа', view: 'Просмотр', edit: 'Правка и пароли' };

export function AuthGate({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Ссылка-приглашение открывается и до входа, и у пользователя без пространств
  const inviteToken = matchPath('/invite/:token', useLocation().pathname)?.params.token;

  useEffect(() => {
    setUnauthorizedHandler(() => qc.invalidateQueries({ queryKey: ['me'] }));
  }, [qc]);

  const me = useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<MeResponse>('/api/me'),
    retry: false,
    staleTime: 60_000,
  });

  // Сервер не подтвердил пространство из заголовка (нет доступа) — берём первое доступное
  useEffect(() => {
    const data = me.data;
    if (!data) return;
    const current = data.current ?? data.workspaces[0] ?? null;
    if (current && current.id !== getApiWorkspace()) {
      rememberWorkspace(current.id);
      if (!data.current) qc.invalidateQueries({ queryKey: ['me'] });
    }
  }, [me.data, qc]);

  const switchWorkspace = useCallback(
    async (id: number) => {
      rememberWorkspace(id);
      api.post(`/api/workspaces/${id}/select`).catch(() => undefined);
      // Данные другого пространства — сбрасываем кэш целиком
      qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
      await qc.invalidateQueries({ queryKey: ['me'] });
    },
    [qc],
  );

  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    qc.clear();
    await qc.invalidateQueries({ queryKey: ['me'] });
  };

  if (me.isPending) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }
  if (me.error || !me.data?.user) {
    const mfa = me.error instanceof ApiError && me.error.code === 'mfa_required';
    return mfa ? <TotpPage onCancel={logout} /> : <LoginPage inviteToken={inviteToken} />;
  }

  const { user, workspaces } = me.data;
  const ws = me.data.current ?? workspaces[0];
  if (!ws && inviteToken) {
    return (
      <AuthCard>
        <InviteJoin
          token={inviteToken}
          onJoined={async (joined) => {
            rememberWorkspace(joined.id);
            navigate('/', { replace: true });
            await qc.invalidateQueries({ queryKey: ['me'] });
          }}
        />
        <Anchor component="button" type="button" size="sm" ta="center" onClick={logout}>
          Выйти
        </Anchor>
      </AuthCard>
    );
  }
  if (!ws) return <NoWorkspacePage onLogout={logout} />;

  return (
    <AuthContext.Provider
      value={{
        user,
        workspaces,
        ws,
        switchWorkspace,
        canInfra: (level) => INFRA_LEVEL[ws.infra] >= INFRA_LEVEL[level],
        canModule: (id, level) => hasModuleLevel(ws, id, level),
        isSysAdmin: user.role === 'admin',
        refreshMe: () => qc.invalidateQueries({ queryKey: ['me'] }),
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

function AuthCard({ children }: { children: ReactNode }) {
  return (
    <Center mih="100vh" p="md">
      <Paper withBorder shadow="sm" p="xl" w={380} maw="100%">
        <Stack>
          <Stack gap={4} align="center">
            <IconServer2 size={36} stroke={1.5} color="var(--mantine-color-indigo-6)" />
            <Title order={3}>Infra Panel</Title>
          </Stack>
          {children}
        </Stack>
      </Paper>
    </Center>
  );
}

function ErrorAlert({ error }: { error?: Error | string | null }) {
  if (!error) return null;
  return (
    <Alert color="red" icon={<IconAlertCircle size={18} />}>
      {typeof error === 'string' ? error : error.message}
    </Alert>
  );
}

interface InvitePreview {
  workspaceName: string;
  infraAccess: InfraAccess;
  /** Права в модулях, работающих в пространстве */
  modules: ModuleLevels;
  canManageMembers: boolean;
  alreadyMember: boolean;
}

function useInvitePreview(token: string | undefined) {
  return useQuery({
    queryKey: ['invite', token],
    queryFn: () => api.post<InvitePreview>('/api/invites/preview', { token }),
    retry: false,
    enabled: !!token,
  });
}

/** Куда и с какими правами зовут; children — только для действующего приглашения */
function InviteSummary({ preview, children }: { preview: UseQueryResult<InvitePreview>; children?: ReactNode }) {
  if (preview.isPending) {
    return (
      <Center>
        <Loader size="sm" />
      </Center>
    );
  }
  if (preview.error) return <ErrorAlert error={preview.error} />;
  const p = preview.data!;
  return (
    <>
      <Text>
        Вас приглашают в пространство <b>{p.workspaceName}</b> с правами:
      </Text>
      <List size="sm" spacing={4}>
        <List.Item>Инфраструктура: {infraLabels[p.infraAccess].toLowerCase()}</List.Item>
        {Object.entries(p.modules).map(([id, level]) => {
          const m = webModule(id);
          return m && <List.Item key={id}>{`${m.title}: ${levelLabel(m, level).toLowerCase()}`}</List.Item>;
        })}
        {p.canManageMembers && <List.Item>Может управлять участниками</List.Item>}
      </List>
      {children}
    </>
  );
}

/** Приглашение для вошедшего пользователя: посмотреть и вступить */
export function InviteJoin({ token, onJoined }: { token: string; onJoined: (ws: WorkspaceAccess) => void }) {
  const preview = useInvitePreview(token);
  const accept = useMutation({
    mutationFn: () => api.post<WorkspaceAccess>('/api/invites/accept', { token }),
    onSuccess: onJoined,
  });
  return (
    <InviteSummary preview={preview}>
      {accept.error && <Alert color="red">{accept.error.message}</Alert>}
      {preview.data?.alreadyMember ? (
        <Alert color="blue">Вы уже участник этого пространства.</Alert>
      ) : (
        <Button onClick={() => accept.mutate()} loading={accept.isPending}>
          Вступить
        </Button>
      )}
    </InviteSummary>
  );
}

function LoginPage({ inviteToken }: { inviteToken?: string }) {
  const qc = useQueryClient();
  const form = useForm({ initialValues: { email: '', password: '' } });
  // Кнопки входа через модули: сервер отдаёт только включённые
  const providers = useQuery({ queryKey: ['auth-providers'], queryFn: () => api.get<AuthProvider[]>('/api/auth/providers'), retry: false });
  const hasProviders = !!providers.data?.length;
  const authError = new URLSearchParams(window.location.search).get('auth_error');
  const preview = useInvitePreview(inviteToken);
  // Действующее приглашение: регистрация и вход через модуль с вступлением
  const invite = preview.data ? inviteToken : undefined;
  const [mode, setMode] = useState<'register' | 'login'>('register');
  const login = useMutation({
    mutationFn: (v: typeof form.values) => api.post<{ user?: SessionUser; mfaRequired?: boolean }>('/api/auth/login', v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
  });

  return (
    <AuthCard>
      {inviteToken && <InviteSummary preview={preview} />}
      <ErrorAlert error={authError} />
      {inviteToken && preview.isPending ? null : (
        <>
          {hasProviders && (
            <>
              {providers.data!.map((p) => {
                const m = webModules().find((x) => x.id === p.id);
                const Icon = m?.icon ?? IconLogin;
                return (
                  <Button
                    key={p.id}
                    component="a"
                    href={invite ? `${p.url}${p.url.includes('?') ? '&' : '?'}invite=${encodeURIComponent(invite)}` : p.url}
                    size="md"
                    color={m?.loginColor}
                    leftSection={<Icon size={18} />}
                    fullWidth
                  >
                    {p.label}
                  </Button>
                );
              })}
              <Divider label="или по email" labelPosition="center" />
            </>
          )}
          {invite && (
            <SegmentedControl
              fullWidth
              value={mode}
              onChange={(v) => setMode(v as typeof mode)}
              data={[
                { value: 'register', label: 'Новый аккаунт' },
                { value: 'login', label: 'Уже есть аккаунт' },
              ]}
            />
          )}
          {invite && mode === 'register' ? (
            <RegisterForm token={invite} primary={!hasProviders} />
          ) : (
            <form onSubmit={form.onSubmit((v) => login.mutate(v))}>
              <Stack>
                <ErrorAlert error={login.error} />
                <TextInput label="Email" type="email" autoComplete="username" required {...form.getInputProps('email')} />
                <PasswordInput label="Пароль" autoComplete="current-password" required {...form.getInputProps('password')} />
                <Button type="submit" loading={login.isPending} fullWidth variant={hasProviders ? 'light' : 'filled'}>
                  Войти
                </Button>
              </Stack>
            </form>
          )}
        </>
      )}
    </AuthCard>
  );
}

/** Регистрация по приглашению: аккаунт создаётся и сразу вступает в пространство */
function RegisterForm({ token, primary }: { token: string; primary: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const form = useForm({
    initialValues: { name: '', email: '', password: '' },
    validate: { password: (v) => (v.length < 10 ? 'Пароль не короче 10 символов' : null) },
  });
  const register = useMutation({
    mutationFn: (v: typeof form.values) => api.post<{ workspace: WorkspaceAccess }>('/api/invites/register', { token, ...v }),
    onSuccess: async (r) => {
      rememberWorkspace(r.workspace.id);
      navigate('/', { replace: true });
      await qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fields) form.setErrors(e.fields);
    },
  });
  return (
    <form onSubmit={form.onSubmit((v) => register.mutate(v))}>
      <Stack>
        <ErrorAlert error={register.error} />
        <TextInput label="Имя" autoComplete="name" required {...form.getInputProps('name')} />
        <TextInput label="Email" type="email" autoComplete="username" required {...form.getInputProps('email')} />
        <PasswordInput
          label="Пароль"
          description="Не короче 10 символов"
          autoComplete="new-password"
          required
          {...form.getInputProps('password')}
        />
        <Button type="submit" loading={register.isPending} fullWidth variant={primary ? 'filled' : 'light'}>
          Создать аккаунт и вступить
        </Button>
      </Stack>
    </form>
  );
}

function TotpPage({ onCancel }: { onCancel: () => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const verify = useMutation({
    mutationFn: (c: string) => api.post('/api/auth/totp', { code: c }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['me'] }),
    onError: () => setCode(''),
  });

  return (
    <AuthCard>
      <Text ta="center" size="sm" c="dimmed">
        Введите 6-значный код из приложения-аутентификатора
      </Text>
      <ErrorAlert error={verify.error} />
      <Center>
        <PinInput length={6} type="number" oneTimeCode autoFocus value={code} onChange={setCode} onComplete={(v) => verify.mutate(v)} disabled={verify.isPending} />
      </Center>
      <Anchor component="button" type="button" size="sm" ta="center" onClick={onCancel}>
        Войти под другим пользователем
      </Anchor>
    </AuthCard>
  );
}

/** Пользователь без пространств (например, его удалили из всех) — создать своё */
function NoWorkspacePage({ onLogout }: { onLogout: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('Моё пространство');
  const create = useMutation({
    mutationFn: () => api.post<WorkspaceAccess>('/api/workspaces', { name }),
    onSuccess: (ws) => {
      setApiWorkspace(ws.id);
      qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
  return (
    <AuthCard>
      <Text size="sm">У вас нет доступа ни к одному пространству. Создайте своё или откройте ссылку-приглашение.</Text>
      <TextInput label="Название" value={name} onChange={(e) => setName(e.currentTarget.value)} />
      <Button onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim()}>
        Создать пространство
      </Button>
      <Anchor component="button" type="button" size="sm" ta="center" onClick={onLogout}>
        Выйти
      </Anchor>
    </AuthCard>
  );
}
