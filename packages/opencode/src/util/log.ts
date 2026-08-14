export type Logger = {
  debug(message?: any, extra?: Record<string, any>): void
  info(message?: any, extra?: Record<string, any>): void
  error(message?: any, extra?: Record<string, any>): void
  warn(message?: any, extra?: Record<string, any>): void
  tag(key: string, value: string): Logger
  clone(): Logger
}

function noop() {}

function createLogger(_opts: { service: string }): Logger {
  const logger: Logger = {
    debug: noop,
    info: noop,
    error: noop,
    warn: noop,
    tag: () => logger,
    clone: () => createLogger(_opts),
  }
  return logger
}

export const Log = {
  create: createLogger,
}
