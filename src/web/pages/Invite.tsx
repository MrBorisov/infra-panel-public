import { Button, Card, Center, Group, Stack, Title } from '@mantine/core';
import { IconUsersGroup } from '@tabler/icons-react';
import { useNavigate, useParams } from 'react-router';
import { InviteJoin, useAuth } from '../auth';

export function InvitePage() {
  const { token = '' } = useParams();
  const { switchWorkspace } = useAuth();
  const navigate = useNavigate();

  return (
    <Center p="md">
      <Card withBorder w={480} maw="100%" p="xl">
        <Stack>
          <Group gap="xs">
            <IconUsersGroup size={28} stroke={1.5} />
            <Title order={3}>Приглашение</Title>
          </Group>
          <InviteJoin
            token={token}
            onJoined={async (ws) => {
              await switchWorkspace(ws.id);
              navigate('/', { replace: true });
            }}
          />
          <Button variant="subtle" onClick={() => navigate('/')}>
            На главную
          </Button>
        </Stack>
      </Card>
    </Center>
  );
}
