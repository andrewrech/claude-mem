import { expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ListRootsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';

it('the built MCP process rechecks root selection on each call without reconnecting or sending denied work', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'cmem-mcp-policy-'));
  const selected = join(directory, 'selected'), other = join(directory, 'other'), dataDir = join(directory, 'data');
  mkdirSync(selected); mkdirSync(other); mkdirSync(dataDir);
  const settingsPath = join(dataDir, 'settings.json');
  const setPolicy = (value: string) => writeFileSync(settingsPath, JSON.stringify({ CLAUDE_MEM_INCLUDED_PROJECTS: value }));
  setPolicy('[]');
  let saves = 0;
  const worker = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    if (new URL(request.url).pathname === '/api/memory/save') {
      saves++; return Response.json({ success: true, id: saves, title: 'Allowed fixture memory' });
    }
    return Response.json({ status: 'ok', version: '15.17.0' });
  } });
  const env = { ...process.env, CLAUDE_MEM_DATA_DIR: dataDir, CLAUDE_MEM_EXCLUDED_PROJECTS: '',
    CLAUDE_MEM_WORKER_PORT: String(worker.port), CLAUDE_MEM_WORKER_HOST: '127.0.0.1',
    CLAUDE_MEM_WORKER_AUTOSTART: 'false', CLAUDE_MEM_RUNTIME: 'worker', CLAUDE_MEM_TELEMETRY: 'false' };
  delete env.CLAUDE_MEM_INCLUDED_PROJECTS;
  delete env.CLAUDE_MEM_WORKER_URL;
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [join(process.cwd(), 'plugin/scripts/mcp-server.cjs')], cwd: selected, stderr: 'pipe',
    env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
  });
  const client = new Client({ name: 'project-opt-in-fixture', version: '1' }, { capabilities: { roots: { listChanged: true } } });
  let currentRoot = selected, rootsFail = false;
  client.setRequestHandler(ListRootsRequestSchema, async () => {
    if (rootsFail) throw new Error('Workspace lookup temporarily unavailable');
    return { roots: [{ uri: pathToFileURL(currentRoot).href, name: 'workspace' }] };
  });
  const save = () => client.callTool({ name: 'save_memory', arguments: { text: 'Fresh authorized memory.', project: 'selected' } }) as Promise<CallToolResult>;
  try {
    await client.connect(transport);
    expect((await save()).isError).toBe(true);
    expect(saves).toBe(0);
    setPolicy(JSON.stringify([selected]));
    expect((await save()).isError).not.toBe(true);
    expect(saves).toBe(1);
    currentRoot = other; rootsFail = true;
    await client.sendRootsListChanged();
    expect((await save()).isError).toBe(true); // The cached selected root cannot authorize the changed workspace.
    expect(saves).toBe(1);
    rootsFail = false;
    expect((await save()).isError).toBe(true); // Verified, but unselected, new root.
    expect(saves).toBe(1);
    currentRoot = selected;
    await client.sendRootsListChanged();
    expect((await save()).isError).not.toBe(true);
    expect(saves).toBe(2);
    setPolicy('[]');
    expect((await save()).isError).toBe(true);
    expect((await client.callTool({ name: 'search', arguments: { query: 'fixture' } })).isError).toBe(true);
    expect(saves).toBe(2);
    setPolicy('{malformed');
    expect((await save()).isError).toBe(true);
    expect(saves).toBe(2);
  } finally {
    await client.close(); await transport.close(); worker.stop(true);
    rmSync(directory, { recursive: true, force: true });
  }
}, 15_000);
