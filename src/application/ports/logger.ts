/**
 * Emits operational messages without coupling use cases to a logging library.
 * Adapters must not throw, even if their destination fails. Messages must not
 * include credentials or media; callers handle failures independently of logs.
 */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}
