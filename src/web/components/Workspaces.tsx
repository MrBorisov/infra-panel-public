import { Modal, Stack, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { WorkspaceAccess } from '../../shared/types';
import { api } from '../api';
import { useAuth } from '../auth';
import { FormFooter } from './FormFooter';

export function CreateWorkspaceModal({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { switchWorkspace } = useAuth();
  const [name, setName] = useState('');
  const create = useMutation({
    mutationFn: () => api.post<WorkspaceAccess>('/api/workspaces', { name }),
    onSuccess: async (ws) => {
      onClose();
      setName('');
      await switchWorkspace(ws.id);
      notifications.show({ color: 'teal', message: `Пространство «${ws.name}» создано` });
    },
    onError: (e) => notifications.show({ color: 'red', message: e.message }),
  });
  return (
    <Modal opened={opened} onClose={onClose} title="Новое пространство">
      <Stack>
        <Text size="sm" c="dimmed">
          Отдельный набор серверов, сайтов и доменов со своими участниками. Например, для другого проекта или клиента.
        </Text>
        <TextInput label="Название" placeholder="Например: Корпорация TEST" value={name} onChange={(e) => setName(e.currentTarget.value)} data-autofocus />
        <FormFooter onCancel={onClose} onClick={() => create.mutate()} loading={create.isPending} disabled={!name.trim()}>
          Создать
        </FormFooter>
      </Stack>
    </Modal>
  );
}
