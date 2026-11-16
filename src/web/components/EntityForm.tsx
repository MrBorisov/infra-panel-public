import {
  Autocomplete,
  Box,
  Button,
  Divider,
  Group,
  NumberInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Switch,
  Text,
  Textarea,
  TextInput,
} from '@mantine/core';
import { DateInput } from '@mantine/dates';
import { useForm } from '@mantine/form';
import { notifications } from '@mantine/notifications';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, type FocusEvent } from 'react';
import type { AnyEntity, EntityPath } from '../../shared/types';
import { api, ApiError } from '../api';
import { useAutofill, type FormValues } from '../autofill';
import { currencyOptions, periodOptions, useLookups, type EntityConfig, type FieldDef } from '../entities';
import { providerPresets } from '../providers';
import { CredentialDrafts, newDraft, saveDrafts } from './CredentialDrafts';
import type { CredentialDraft } from './credentialKinds';
import { RefSelect } from './RefSelect';

const toRef = (v: unknown) => (v != null && v !== '' ? String(v) : null);

function initialValues(config: EntityConfig, entity?: AnyEntity | null, prefill?: FormValues): FormValues {
  const src = { ...((entity ?? {}) as unknown as FormValues), ...(prefill ?? {}) };
  const out: FormValues = {};
  for (const f of config.fields) {
    const v = src[f.name];
    switch (f.type) {
      case 'switch':
        out[f.name] = typeof v === 'boolean' ? v : (f.defaultValue ?? false);
        break;
      case 'ref':
        out[f.name] = toRef(v);
        break;
      case 'date':
        out[f.name] = v ?? null;
        break;
      case 'money':
        out.price = src.price ?? '';
        out.currency = src.currency ?? 'RUB';
        out.billingPeriod = src.billingPeriod ?? f.defaultValue ?? 'month';
        break;
      case 'placement':
        out.serverId = toRef(src.serverId);
        out.hostingId = toRef(src.hostingId);
        out.placementType = out.hostingId ? 'hosting' : out.serverId || !entity ? 'server' : 'none';
        break;
      default:
        out[f.name] = v ?? f.defaultValue ?? '';
    }
  }
  // Какие доступы предложить сразу при создании: обычный для объекта, у домена — никаких
  if (!entity) out.credentials = config.path === 'domains' ? [] : [newDraft(config.defaultCredentialKind)];
  return out;
}

function toPayload(config: EntityConfig, values: FormValues) {
  const out: FormValues = {};
  for (const f of config.fields) {
    const v = values[f.name];
    switch (f.type) {
      case 'ref':
        out[f.name] = v ? Number(v) : null;
        break;
      case 'number':
        out[f.name] = v === '' || v == null ? null : Number(v);
        break;
      case 'money':
        out.price = values.price === '' || values.price == null ? null : Number(values.price);
        out.currency = values.currency;
        out.billingPeriod = values.billingPeriod;
        break;
      case 'placement':
        out.serverId = values.placementType === 'server' && values.serverId ? Number(values.serverId) : null;
        out.hostingId = values.placementType === 'hosting' && values.hostingId ? Number(values.hostingId) : null;
        break;
      default:
        out[f.name] = v;
    }
  }
  return out;
}

/** При «Сохранить и добавить ещё» оставляем выбранные связи, валюту и т. п., чтобы быстро вводить похожие записи */
function stickyValues(config: EntityConfig, values: FormValues): FormValues {
  const out: FormValues = {};
  for (const f of config.fields) {
    // Домен у каждого сайта свой, его не переносим
    if ((f.type === 'ref' && f.name !== 'domainId') || f.type === 'switch') out[f.name] = values[f.name];
    if (f.type === 'money') Object.assign(out, { currency: values.currency, billingPeriod: values.billingPeriod });
    if (f.type === 'placement') Object.assign(out, { placementType: values.placementType, serverId: values.serverId, hostingId: values.hostingId });
    if (f.name === 'provider' || f.name === 'monitorPort') out[f.name] = values[f.name];
  }
  return out;
}

export function EntityForm({
  config,
  entity,
  prefill,
  onSaved,
  onCancel,
  registerDirtyCheck,
}: {
  config: EntityConfig;
  entity?: AnyEntity | null;
  prefill?: FormValues;
  onSaved: (saved: AnyEntity, addAnother: boolean) => void;
  onCancel: () => void;
  registerDirtyCheck?: (fn: () => boolean) => void;
}) {
  const qc = useQueryClient();
  const lookups = useLookups();
  const form = useForm<FormValues>({ initialValues: initialValues(config, entity, prefill) });
  const { hints, onBlur, onProviderSelect, clearHint, resetHints } = useAutofill(config.path, form, lookups);
  const addAnother = useRef(false);
  const firstInput = useRef<{ focus: () => void }>(null);
  const isCreate = !entity;

  useEffect(() => {
    registerDirtyCheck?.(() => form.isDirty());
  }, [registerDirtyCheck, form]);

  const save = useMutation({
    mutationFn: async ({ values, another }: { values: FormValues; another: boolean }) => {
      const payload = toPayload(config, values);
      const saved = entity
        ? await api.patch<AnyEntity>(`/api/${config.path}/${entity.id}`, payload)
        : await api.post<AnyEntity>(`/api/${config.path}`, payload);
      const failed = isCreate ? await saveDrafts((values.credentials ?? []) as CredentialDraft[], config.type, saved.id) : 0;
      return { saved, failed, another };
    },
    onSuccess: ({ saved, failed, another }) => {
      qc.invalidateQueries({ queryKey: [config.path] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      qc.invalidateQueries({ queryKey: ['credentials', config.type, saved.id] });
      notifications.show({ color: 'teal', message: entity ? 'Изменения сохранены' : `${config.single} «${saved.name}» добавлен` });
      if (failed) {
        notifications.show({ color: 'red', message: `Не сохранились доступы (${failed}). Добавьте их в карточке объекта` });
      }
      if (another) {
        const next = { ...initialValues(config, null, prefill), ...stickyValues(config, form.getValues()) };
        form.setValues(next);
        form.resetDirty(next);
        resetHints();
        setTimeout(() => firstInput.current?.focus(), 0);
      }
      onSaved(saved, another);
    },
    onError: (e) => {
      if (e instanceof ApiError && e.fields) form.setErrors(e.fields);
      notifications.show({ color: 'red', title: 'Не удалось сохранить', message: e.message });
    },
  });

  const withBlur = (f: FieldDef) => {
    const props = form.getInputProps(f.name);
    const extra = onBlur[f.name];
    return extra
      ? {
          ...props,
          onBlur: (e: FocusEvent<HTMLElement>) => {
            props.onBlur?.(e);
            extra();
          },
        }
      : props;
  };

  const placementSelect = (field: 'serverId' | 'hostingId', refPath: EntityPath, placeholder: string) => (
    <RefSelect
      refPath={refPath}
      placeholder={placeholder}
      value={form.getValues()[field] as string | null}
      onChange={(v) => {
        form.setFieldValue(field, v);
        clearHint('placement');
      }}
    />
  );

  const renderField = (f: FieldDef, isFirst: boolean) => {
    const common = {
      label: f.label,
      description: f.description,
      placeholder: f.placeholder,
      required: f.required,
      // Поле может быть input или textarea, ref нужен только для focus()
      ...(isFirst ? { 'data-autofocus': true, ref: firstInput as never } : {}),
    };
    switch (f.type) {
      case 'textarea':
        return <Textarea {...common} autosize minRows={2} maxRows={8} {...form.getInputProps(f.name)} />;
      case 'number':
        return <NumberInput {...common} min={0} allowNegative={false} {...form.getInputProps(f.name)} />;
      case 'date':
        return <DateInput {...common} valueFormat="DD.MM.YYYY" clearable placeholder="ДД.ММ.ГГГГ" {...form.getInputProps(f.name)} />;
      case 'switch':
        return <Switch label={f.label} description={f.description} mt={6} {...form.getInputProps(f.name, { type: 'checkbox' })} />;
      case 'ref':
        return (
          <RefSelect
            {...common}
            refPath={f.ref!}
            value={form.getValues()[f.name] as string | null}
            onChange={(v) => {
              form.setFieldValue(f.name, v);
              clearHint(f.name);
            }}
            error={form.errors[f.name]}
          />
        );
      case 'provider':
        return (
          <Autocomplete
            {...common}
            data={providerPresets.map((p) => p.name)}
            {...withBlur(f)}
            onOptionSubmit={onProviderSelect}
          />
        );
      case 'money':
        return (
          <Group gap="xs" align="flex-end" wrap="nowrap">
            <NumberInput
              label={f.label}
              placeholder="0"
              style={{ flex: 1 }}
              min={0}
              allowNegative={false}
              decimalSeparator=","
              thousandSeparator=" "
              hideControls
              {...form.getInputProps('price')}
            />
            <Select w={84} data={currencyOptions} allowDeselect={false} aria-label="Валюта" {...form.getInputProps('currency')} />
            <Select w={104} data={periodOptions} allowDeselect={false} aria-label="Период оплаты" {...form.getInputProps('billingPeriod')} />
          </Group>
        );
      case 'placement': {
        const type = form.getValues().placementType as string;
        return (
          <Stack gap="xs">
            <SegmentedControl
              fullWidth
              data={[
                { value: 'server', label: 'Сервер (VPS)' },
                { value: 'hosting', label: 'Хостинг' },
                { value: 'none', label: 'Не указано' },
              ]}
              {...form.getInputProps('placementType')}
            />
            {type === 'server' && placementSelect('serverId', 'servers', 'Выберите сервер или введите новый')}
            {type === 'hosting' && placementSelect('hostingId', 'hostings', 'Выберите хостинг или введите новый')}
          </Stack>
        );
      }
      default:
        return <TextInput {...common} {...withBlur(f)} />;
    }
  };

  let first = true;

  return (
    <form
      onSubmit={form.onSubmit((values) => {
        save.mutate({ values, another: addAnother.current });
        addAnother.current = false;
      })}
    >
      <Stack gap="lg" pb={72}>
        {config.sections.map((section, si) => (
          <Stack key={si} gap="sm">
            {section.title && <Divider label={section.title} labelPosition="left" />}
            <SimpleGrid cols={{ base: 1, xs: 2 }} spacing="md" verticalSpacing="sm">
              {section.fields.map((f) => {
                const isFirst = first && f.type !== 'switch';
                if (isFirst) first = false;
                return (
                  <Box key={f.name} style={f.full || f.type === 'placement' ? { gridColumn: '1 / -1' } : undefined}>
                    {renderField(f, isFirst)}
                    {hints[f.name] && <Box mt={4}>{hints[f.name]}</Box>}
                  </Box>
                );
              })}
            </SimpleGrid>
          </Stack>
        ))}

        {isCreate && (
          <Stack gap="sm">
            <Divider label="Доступы" labelPosition="left" />
            <CredentialDrafts form={form} entityType={config.type} defaultKind={config.defaultCredentialKind} />
          </Stack>
        )}
      </Stack>

      <Group
        justify="space-between"
        wrap="nowrap"
        gap="xs"
        py="sm"
        style={{
          position: 'sticky',
          bottom: 0,
          background: 'var(--mantine-color-body)',
          borderTop: '1px solid var(--mantine-color-default-border)',
          zIndex: 2,
        }}
      >
        <Button variant="default" onClick={onCancel} visibleFrom="xs">
          Отмена
        </Button>
        <Group gap="xs" wrap="nowrap" style={{ flex: 1, justifyContent: 'flex-end' }}>
          {isCreate && (
            <Button type="submit" variant="light" loading={save.isPending && save.variables?.another} onClick={() => (addAnother.current = true)}>
              <Text span inherit visibleFrom="sm">
                Сохранить и добавить ещё
              </Text>
              <Text span inherit hiddenFrom="sm">
                + ещё
              </Text>
            </Button>
          )}
          <Button type="submit" loading={save.isPending && !save.variables?.another}>
            {isCreate ? 'Сохранить' : 'Сохранить изменения'}
          </Button>
        </Group>
      </Group>
    </form>
  );
}
