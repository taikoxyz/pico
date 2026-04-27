import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { app: 'tainnel-watchtower' },
});

export type Logger = typeof logger;
