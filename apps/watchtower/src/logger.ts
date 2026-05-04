import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { app: 'pico-watchtower' },
});

export type Logger = typeof logger;
