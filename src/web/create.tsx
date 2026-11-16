import { Drawer, Text } from '@mantine/core';
import { modals } from '@mantine/modals';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import type { AnyEntity, EntityPath } from '../shared/types';
import type { FormValues } from './autofill';
import { EntityForm } from './components/EntityForm';
import { entityConfigs } from './entities';

/** Боковая панель с формой: закрытие с несохранёнными изменениями требует подтверждения */
export function EntityDrawer({
  path,
  entity,
  prefill,
  opened,
  onClose,
  onSaved,
}: {
  path: EntityPath;
  entity?: AnyEntity | null;
  prefill?: FormValues;
  opened: boolean;
  onClose: () => void;
  onSaved?: (saved: AnyEntity, addAnother: boolean) => void;
}) {
  const config = entityConfigs[path];
  const isDirty = useRef<() => boolean>(() => false);
  const registerDirtyCheck = useCallback((fn: () => boolean) => (isDirty.current = fn), []);

  const requestClose = () => {
    if (!isDirty.current()) return onClose();
    modals.openConfirmModal({
      title: 'Закрыть без сохранения?',
      children: <Text size="sm">Введённые данные пропадут.</Text>,
      labels: { confirm: 'Закрыть', cancel: 'Вернуться к форме' },
      confirmProps: { color: 'red' },
      onConfirm: onClose,
    });
  };

  return (
    <Drawer
      opened={opened}
      onClose={requestClose}
      position="right"
      size={680}
      title={
        <Text fw={600} size="lg">
          {entity ? `${config.single}: ${entity.name}` : `Новый ${config.accusative}`}
        </Text>
      }
      styles={{ body: { paddingBottom: 0 } }}
    >
      {opened && (
        <EntityForm
          config={config}
          entity={entity}
          prefill={prefill}
          registerDirtyCheck={registerDirtyCheck}
          onCancel={requestClose}
          onSaved={(saved, addAnother) => {
            if (!addAnother) onClose();
            onSaved?.(saved, addAnother);
          }}
        />
      )}
    </Drawer>
  );
}

interface CreateState {
  path: EntityPath;
  prefill?: FormValues;
  key: number;
}

const CreateContext = createContext<{ openCreate: (path: EntityPath, prefill?: FormValues) => void } | null>(null);

export function useCreate() {
  const ctx = useContext(CreateContext);
  if (!ctx) throw new Error('useCreate вне CreateProvider');
  return ctx;
}

/** Создание любой записи из любого места: кнопка в шапке, поиск, карточки объектов */
export function CreateProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [state, setState] = useState<CreateState | null>(null);
  const openCreate = useCallback((path: EntityPath, prefill?: FormValues) => setState({ path, prefill, key: Date.now() }), []);

  return (
    <CreateContext.Provider value={{ openCreate }}>
      {children}
      {state && (
        <EntityDrawer
          key={state.key}
          path={state.path}
          prefill={state.prefill}
          opened
          onClose={() => setState(null)}
          onSaved={(saved, addAnother) => {
            if (!addAnother) navigate(`/${state.path}/${saved.id}`);
          }}
        />
      )}
    </CreateContext.Provider>
  );
}
