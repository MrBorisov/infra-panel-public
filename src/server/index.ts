import { buildApp } from './app.js';
import { config } from './config.js';
import { assertEncryptionKey } from './crypto.js';
import { runMigrations, sqlite } from './db/index.js';
import { startModules, stopModules } from './modules.js';
import { startMonitor, stopMonitor } from './monitor/index.js';
import { setNotifyLogger } from './notify.js';
// Единственное место запуска, где подключаются модули: ядро их не импортирует
import { serverModules } from '../modules/server.js';

assertEncryptionKey();
runMigrations();

const app = await buildApp({ modules: serverModules });
setNotifyLogger(app.log);
startMonitor(app.log);
startModules(app.log);

await app.listen({ port: config.port, host: config.host });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    app.log.info(`${signal}: останавливаемся`);
    stopMonitor();
    stopModules();
    await app.close();
    sqlite.close();
    process.exit(0);
  });
}
