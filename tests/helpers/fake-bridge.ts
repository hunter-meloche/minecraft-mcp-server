import net from 'net';

interface Fake { port: number; server: net.Server; push: (e: object) => void; dropAll: () => void }

/** A fake bridge: answers hello with the right token, echoes, delays, pushes events. */
export function fakeBridge(token = 'secret', handlers: Record<string, (params: Record<string, unknown>) => unknown> = {}): Promise<Fake> {
  const sockets: net.Socket[] = [];
  const server = net.createServer(s => {
    sockets.push(s);
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (d: string) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const req = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        const reply = (body: object) => s.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, ...body }) + '\n');
        if (req.method === 'hello') {
          if (req.params.token === token) reply({ result: { bridge: 'claudebridge', protocol: 1, username: 'Bot' } });
          else { reply({ error: { code: -32000, message: 'hello with the launch token first' } }); s.end(); }
        } else if (handlers[req.method]) reply({ result: handlers[req.method](req.params) });
        else if (req.method === 'echo') reply({ result: req.params });
        else if (req.method === 'slow') setTimeout(() => reply({ result: 'late' }), 300);
        else if (req.method === 'never') { /* no reply */ }
        else reply({ error: { code: -32000, message: `unknown method: ${req.method}` } });
      }
    });
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve({
      port: (server.address() as net.AddressInfo).port,
      server,
      push: e => sockets.forEach(s => s.write(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: e }) + '\n')),
      dropAll: () => sockets.forEach(s => s.destroy())
    }));
  });
}

