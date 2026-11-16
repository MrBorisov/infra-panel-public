import type { ComponentType, ReactNode } from 'react';
import type { EventEntry, WorkspaceAccess } from '../shared/types';

/**
 * Модуль интерфейса — пара к серверному модулю с тем же id. Ядро модули не импортирует: список
 * приходит в main.tsx (`installWebModules`), а модуль берёт из ядра только kit.ts
 */
export interface WebModule {
  id: string;
  title: string;
  /** Уровни доступа по возрастанию — как у серверного модуля, первый — none */
  levels: { value: string; label: string }[];
  /** Пояснение к правам в форме приглашения */
  accessHint?: string;
  icon: ComponentType<{ size?: number }>;
  /** Пункты раздела меню; badge — показать счётчик useAttention */
  nav?: { to: string; label: string; level: string; badge?: boolean }[];
  /**
   * Сколько требует внимания — для меню и «Обзора». Хук: вызывается при каждой отрисовке
   * (список модулей не меняется), enabled — есть ли у участника доступ к модулю
   */
  useAttention?: (enabled: boolean) => number;
  routes?: { path: string; level: string; element: ReactNode }[];
  /** Виджет главной: виден с первым уровнем доступа */
  dashboard?: ComponentType;
  /** Карточки «Настроек» уровня пользователя: сами решают, показываться ли */
  settingsCards?: ComponentType[];
  /** Ссылка из журнала событий на главной */
  eventLink?: (e: EventEntry) => string | null;
  /** Подписи журнала: действия и типы объектов */
  auditActions?: Record<string, { label: string; color: string }>;
  auditEntities?: Record<string, string>;
  /** Цвет кнопки входа через модуль */
  loginColor?: string;
}

let installed: WebModule[] = [];

export const installWebModules = (list: WebModule[]) => {
  installed = [...list];
};
export const webModules = () => installed;
export const webModule = (id: string) => installed.find((m) => m.id === id);

const rank = (m: WebModule, level: string | undefined) => Math.max(0, m.levels.findIndex((l) => l.value === (level ?? 'none')));

/** Уровень участника в модуле не ниже level; модуль выключен в пространстве — нет */
export function hasModuleLevel(ws: WorkspaceAccess, id: string, level: string) {
  const m = webModule(id);
  return !!m && id in ws.modules && rank(m, ws.modules[id]) >= rank(m, level) && rank(m, level) > 0;
}

/** Модули, работающие в пространстве */
export const modulesIn = (ws: WorkspaceAccess) => installed.filter((m) => m.id in ws.modules);

/** Подпись уровня; незнакомый — как есть */
export const levelLabel = (m: WebModule, level: string | undefined) => m.levels.find((l) => l.value === (level ?? 'none'))?.label ?? level ?? '';
