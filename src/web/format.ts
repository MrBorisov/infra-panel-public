import dayjs from 'dayjs';
import 'dayjs/locale/ru';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import relativeTime from 'dayjs/plugin/relativeTime';
import { plural } from '../shared/text';

// customParseFormat нужен DateInput, чтобы разбирать введённые руками даты в формате DD.MM.YYYY
dayjs.extend(customParseFormat);
dayjs.extend(relativeTime);
dayjs.locale('ru');

export const fmtDate = (v: string | number | null | undefined) => (v ? dayjs(v).format('DD.MM.YYYY') : '—');
export const fmtDateTime = (v: number | null | undefined) => (v ? dayjs(v).format('DD.MM.YYYY HH:mm') : '—');
export const fromNow = (v: number | null | undefined) => (v ? dayjs(v).fromNow() : '—');

export function fmtMoney(value: number | null | undefined, currency: string) {
  if (value == null) return '—';
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency, maximumFractionDigits: 2 }).format(value);
}

export function daysUntil(date: string | number) {
  return dayjs(date).startOf('day').diff(dayjs().startOf('day'), 'day');
}

export function daysText(days: number) {
  if (days < 0) return `истёк ${-days} ${plural(-days, ['день', 'дня', 'дней'])} назад`;
  if (days === 0) return 'сегодня';
  return `через ${days} ${plural(days, ['день', 'дня', 'дней'])}`;
}

export function deadlineColor(days: number) {
  if (days <= 7) return 'red';
  if (days <= 30) return 'orange';
  return 'gray';
}

export const fmtUptime = (v: number | null) => (v == null ? '—' : `${v >= 99.995 ? '100' : v.toFixed(2)}%`);

/** Следующая дата оплаты: +1 месяц или +1 год от текущей (или от сегодня) */
export function nextPaymentDate(current: string | null, period: 'month' | 'year') {
  return dayjs(current ?? undefined).add(1, period).format('YYYY-MM-DD');
}
