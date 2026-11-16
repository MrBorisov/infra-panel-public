import type { CredentialKind } from '../../shared/types';

export const kindLabels: Record<CredentialKind, string> = {
  panel: 'Личный кабинет / панель',
  ssh: 'SSH',
  sftp: 'SFTP',
  ftp: 'FTP',
  admin: 'Админка сайта',
  db: 'База данных',
  email: 'Почта',
  api: 'API-токен',
  other: 'Другое',
};

export const defaultPorts: Partial<Record<CredentialKind, number>> = { ssh: 22, sftp: 22, ftp: 21 };

/** Поля доступа, общие у формы в карточке объекта и у черновиков в форме создания */
export interface CredentialDraft {
  kind: CredentialKind;
  address: string;
  port: number | string;
  username: string;
  secret: string;
  passworkUrl: string;
}

export function credentialBody(v: CredentialDraft) {
  return {
    kind: v.kind,
    address: v.address,
    port: v.port === '' ? null : Number(v.port),
    username: v.username,
    passworkUrl: v.passworkUrl,
    ...(v.secret ? { secret: v.secret } : {}),
  };
}
