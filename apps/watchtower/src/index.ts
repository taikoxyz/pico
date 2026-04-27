import { loadConfig } from './config.js';
import { FraudDetector } from './detector.js';
import { logger } from './logger.js';
import { PenaltyResponder } from './responder.js';
import { MemoryBackupStore } from './storage.js';
import { ChainEventWatcher } from './watcher.js';

export async function start(): Promise<void> {
  const config = loadConfig();
  logger.info({ mode: config.mode, port: config.port }, 'watchtower starting (stub)');
  const detector = new FraudDetector();
  const responder = new PenaltyResponder(config.rpcUrl, config.privateKey, logger);
  const watcher = new ChainEventWatcher(config.rpcUrl, logger);
  const store = new MemoryBackupStore();
  await watcher.start(async (event) => {
    const result = detector.evaluate(event.channelId, event.version);
    if (result.fraudulent) {
      const backup = await store.latest(event.channelId);
      logger.warn({ event, result, hasBackup: !!backup }, 'fraud detected (stub)');
      throw new Error('not implemented');
    }
  });
  void responder;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  start().catch((err) => {
    logger.error({ err }, 'watchtower failed to start');
    process.exit(1);
  });
}

export * from './config.js';
export * from './detector.js';
export * from './responder.js';
export * from './storage.js';
export * from './watcher.js';
