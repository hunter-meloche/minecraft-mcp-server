// Keep one MCP session (and so one bot connection) open and take tool calls over HTTP on 127.0.0.1, so scripts
// (and people) can drive a bot that stays online between calls.
// usage: node scripts/lab/mcp-http.mjs <username> [httpPort]   (extra server flags in MCP_EXTRA_ARGS, e.g. "--backend client")
//   curl -s 127.0.0.1:7777/call -d '{"name":"get-status","args":{}}'
//   curl -s 127.0.0.1:7777/stop
import http from 'http';
import { createRequire } from 'module';
const repo = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const require = createRequire(repo + 'package.json');
const { Client } = await import('file:///' + require.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { StdioClientTransport } = await import('file:///' + require.resolve('@modelcontextprotocol/sdk/client/stdio.js'));

const username = process.argv[2] ?? 'ClaudeFresh';
const port = Number(process.argv[3] ?? 7777);
const transport = new StdioClientTransport({
  command: 'node',
  args: [repo + 'dist/main.js', '--host', process.env.MC_HOST ?? 'localhost', '--port', process.env.MC_PORT ?? '25565', '--username', username, ...(process.env.MCP_EXTRA_ARGS ?? '').split(' ').filter(Boolean)],
  // the whole environment, not the SDK's safe few: on a headless Linux box the game client needs DISPLAY (xvfb-run)
  env: Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)),
  stderr: 'ignore'
});
const client = new Client({ name: 'live-test', version: '0' });
await client.connect(transport);
const text = r => r.content.map(c => c.text).join('\n');

http.createServer(async (req, res) => {
  if (req.url === '/stop') { res.end('bye\n'); await client.close(); process.exit(0); }
  let body = '';
  for await (const chunk of req) body += chunk;
  try {
    const { name, args = {} } = JSON.parse(body);
    let result;
    for (let i = 0; i < 20; i++) {
      result = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
      if (!/is connecting/i.test(text(result))) break;
      await new Promise(r => setTimeout(r, 1000));
    }
    res.end(`${result.isError ? '[error] ' : ''}${text(result)}\n`);
  } catch (e) {
    res.end(`[harness error] ${e?.message ?? e}\n`);
  }
}).listen(port, '127.0.0.1', () => console.log(`listening on ${port} as ${username}`));
