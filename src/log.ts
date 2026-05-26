import pino from 'pino';

const level = process.env.LOG_LEVEL ?? 'info';

export const log = pino({
  level,
  redact: {
    paths: [
      'err.bodyText',
      'err.headers["x-api-key"]',
      'err.headers.authorization',
      'err.request.headers["x-api-key"]',
      'err.request.headers.authorization',
      'err.cause.request.headers["x-api-key"]',
      'err.cause.headers["x-api-key"]',
      '*.bearerToken',
      'token',
    ],
    censor: '[REDACTED]',
  },
  transport:
    process.env.NODE_ENV === 'production'
      ? undefined
      : {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
});
