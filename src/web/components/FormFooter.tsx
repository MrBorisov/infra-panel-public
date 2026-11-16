import { Button, Group, type ButtonProps } from '@mantine/core';

/** Подвал формы или окна: «Отмена» и главная кнопка справа; пропсы, кроме onCancel, уходят главной кнопке */
export function FormFooter({ onCancel, children, ...submit }: ButtonProps & { onCancel: () => void; onClick?: () => void; type?: 'submit' }) {
  return (
    <Group justify="flex-end">
      <Button variant="default" onClick={onCancel}>
        Отмена
      </Button>
      <Button {...submit}>{children}</Button>
    </Group>
  );
}
