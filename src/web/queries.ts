import { useQuery } from '@tanstack/react-query';
import type { Dashboard } from '../shared/types';
import { api } from './api';

// Запросы, которые читают несколько экранов: ключ, адрес и интервал заданы в одном месте,
// чтобы наблюдатели одного ключа не разошлись в адресе или частоте опроса

export function useDashboard(enabled = true) {
  return useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<Dashboard>('/api/dashboard'), refetchInterval: 30_000, enabled });
}
