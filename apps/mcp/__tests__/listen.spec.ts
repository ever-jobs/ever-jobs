import express from 'express';
import { createServer, get, Server } from 'http';
import { AddressInfo } from 'net';

import { listenOrExit } from '../src/listen';

/**
 * The MCP HTTP mode must still fail hard when its port is taken. Express 5
 * hands the listen error to the `app.listen` callback (Express 4 crashed on
 * an unhandled server 'error'), so a callback that ignores it would log
 * "started" and exit 0 with nothing listening. Loopback only: no network.
 */
describe('MCP HTTP listen (express 5)', () => {
  const opened: Server[] = [];

  const close = (server: Server) =>
    new Promise<void>((resolve) => {
      if (!server.listening) return resolve();
      server.close(() => resolve());
    });

  /** A server holding a port, bound the same way `app.listen(port)` binds. */
  const occupyPort = async (): Promise<number> => {
    const blocker = createServer();
    opened.push(blocker);
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    return (blocker.address() as AddressInfo).port;
  };

  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(opened.splice(0).map(close));
  });

  it('reports listening and serves requests when the port is free', async () => {
    const app = express();
    app.get('/health', (_req, res) => {
      res.json({ status: 'healthy' });
    });
    const onError = jest.fn();

    const server = await new Promise<Server>((resolve) => {
      const s = listenOrExit(app, 0, () => resolve(s), onError);
      opened.push(s);
    });

    expect(onError).not.toHaveBeenCalled();
    const { port } = server.address() as AddressInfo;
    const res = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
      get({ host: '127.0.0.1', port, path: '/health', agent: false }, (r) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (chunk: string) => (body += chunk));
        r.on('end', () => resolve({ status: r.statusCode, body }));
      }).on('error', reject);
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ status: 'healthy' });
  });

  it('routes EADDRINUSE to onError instead of reporting "started"', async () => {
    const port = await occupyPort();
    const onListening = jest.fn();

    const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
      opened.push(listenOrExit(express(), port, onListening, (err) => resolve(err)));
    });

    expect(error.code).toBe('EADDRINUSE');
    expect(onListening).not.toHaveBeenCalled();
  });

  it('by default logs "Fatal error:" and exits with code 1 (the express 4 exit code)', async () => {
    const port = await occupyPort();
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const exited = new Promise<number | undefined>((resolve) => {
      jest.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        resolve(code);
        return undefined as never;
      }) as typeof process.exit);
    });
    const onListening = jest.fn();

    opened.push(listenOrExit(express(), port, onListening));

    await expect(exited).resolves.toBe(1);
    expect(onListening).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Fatal error:', expect.objectContaining({ code: 'EADDRINUSE' }));
  });
});
