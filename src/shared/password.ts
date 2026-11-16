// Генератор паролей, общий для CLI сервера и интерфейса. Без импортов: файл попадает в бандл фронтенда,
// а crypto — глобальный Web Crypto, он есть и в браузере, и в Node

export function generatePassword(length = 20): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
