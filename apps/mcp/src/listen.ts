import type { Server } from 'http';

/** The slice of an Express app that {@link listenOrExit} needs. */
export interface Listenable {
  listen(port: number, callback: (error?: Error) => void): Server;
}

/** Default failure path: the same `Fatal error:` line and exit code 1 as `main()`. */
function exitOnListenError(error: Error): void {
  console.error('Fatal error:', error);
  process.exit(1);
}

/**
 * Start the HTTP listener and keep "port unavailable" fatal.
 *
 * Express 5's `app.listen` passes a listen failure (e.g. `EADDRINUSE`) to the
 * callback, where Express 4 left it as an unhandled server `'error'` that
 * crashed the process with exit code 1. A callback that ignores its argument
 * would log "started" while nothing listens and let the process exit 0, so
 * the error is routed to `onError` (default: log + `process.exit(1)`).
 */
export function listenOrExit(
  app: Listenable,
  port: number,
  onListening: () => void,
  onError: (error: Error) => void = exitOnListenError,
): Server {
  return app.listen(port, (error?: Error) => {
    if (error) {
      onError(error);
      return;
    }
    onListening();
  });
}
