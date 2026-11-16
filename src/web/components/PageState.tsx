import { Anchor, Center, Loader, Stack, Text } from '@mantine/core';
import { Link } from 'react-router';

export function PageLoader() {
  return (
    <Center p="xl">
      <Loader />
    </Center>
  );
}

/** Объекта нет или его не отдали: текст ошибки и ссылка обратно к списку */
export function NotFound({ error, to, label }: { error: Error | null; to: string; label: string }) {
  return (
    <Stack align="center" p="xl">
      <Text>{error?.message ?? 'Не найдено'}</Text>
      <Anchor component={Link} to={to}>
        {label}
      </Anchor>
    </Stack>
  );
}
