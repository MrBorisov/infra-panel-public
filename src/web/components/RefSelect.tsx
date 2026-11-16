import { Select, type SelectProps } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { AnyEntity, EntityPath } from '../../shared/types';
import { api } from '../api';
import { useAuth } from '../auth';
import { entityConfigs, useLookups } from '../entities';
import { findPreset } from '../providers';

const CREATE = '__create__';

/** Выбор связанного объекта. Если нужного нет — можно создать прямо отсюда по введённому названию */
export function RefSelect({
  refPath,
  value,
  onChange,
  ...props
}: { refPath: EntityPath; value: string | null; onChange: (v: string | null) => void } & Omit<SelectProps, 'data' | 'value' | 'onChange'>) {
  const { canInfra } = useAuth();
  const qc = useQueryClient();
  const lookups = useLookups();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);

  const options = lookups.lists[refPath].map((x) => ({ value: String(x.id), label: x.name }));
  const q = search.trim();
  const selectedLabel = options.find((o) => o.value === value)?.label;
  const exists = options.some((o) => o.label.toLowerCase() === q.toLowerCase());
  const offerCreate = canInfra('edit') && q.length > 0 && !exists && q !== selectedLabel;
  const data = offerCreate ? [...options, { value: CREATE, label: `+ Создать «${q}»` }] : options;

  const create = async (name: string) => {
    setCreating(true);
    try {
      // Для аккаунта известного провайдера сразу подставляем ссылку на ЛК
      const preset = refPath === 'accounts' ? findPreset(name) : undefined;
      const created = await api.post<AnyEntity>(`/api/${refPath}`, preset ? { name, provider: preset.name, url: preset.url } : { name });
      qc.setQueryData<AnyEntity[]>([refPath], (old) => [...(old ?? []), created]);
      qc.invalidateQueries({ queryKey: [refPath] });
      onChange(String(created.id));
      notifications.show({ color: 'teal', message: `${entityConfigs[refPath].single} «${created.name}» создан` });
    } catch (e) {
      notifications.show({ color: 'red', message: e instanceof Error ? e.message : 'Не удалось создать' });
    } finally {
      setCreating(false);
    }
  };

  return (
    <Select
      {...props}
      data={data}
      value={value}
      searchable
      clearable
      searchValue={search}
      onSearchChange={setSearch}
      disabled={props.disabled || creating}
      nothingFoundMessage={canInfra('edit') ? 'Начните вводить название, чтобы создать' : 'Ничего не найдено'}
      onChange={(v) => {
        if (v === CREATE) create(q);
        else onChange(v);
      }}
    />
  );
}
