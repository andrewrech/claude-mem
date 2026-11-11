import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { startCaptureWorker, type CaptureWorker } from '../helpers/deleted-session-capture-fixture.js';
import { SessionManager } from '../../src/services/worker/SessionManager.js';
import { SessionRoutes } from '../../src/services/worker/http/routes/SessionRoutes.js';
import { MemoryRoutes } from '../../src/services/worker/http/routes/MemoryRoutes.js';
import { SearchRoutes } from '../../src/services/worker/http/routes/SearchRoutes.js';

const ENV_KEYS = ['CLAUDE_MEM_INCLUDED_PROJECTS', 'CLAUDE_MEM_EXCLUDED_PROJECTS', 'CLAUDE_MEM_OBSERVER_ENABLED', 'CLAUDE_MEM_TELEMETRY'];
let saved: Record<string, string | undefined>;
let directory: string, root: string, other: string;
let worker: CaptureWorker;
beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  directory = mkdtempSync(join(tmpdir(), 'cmem-inclusion-http-'));
  root = join(directory, 'selected'); other = join(directory, 'other');
  mkdirSync(root); mkdirSync(other);
  process.env.CLAUDE_MEM_INCLUDED_PROJECTS = JSON.stringify([root]);
  process.env.CLAUDE_MEM_EXCLUDED_PROJECTS = '';
  process.env.CLAUDE_MEM_OBSERVER_ENABLED = 'true';
  process.env.CLAUDE_MEM_TELEMETRY = 'false';
  worker = await startCaptureWorker();
});
afterEach(async () => {
  await worker.close();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
  }
  rmSync(directory, { recursive: true, force: true });
});

function databaseManager() {
  return { getSessionStore: () => worker.store, getSessionById: (id: number) => worker.store.getSessionById(id), getCloudSync: () => null, getChromaSync: () => null };
}

describe('worker project opt-in boundaries', () => {
  for (const platformSource of ['claude', 'codex', 'kimi', 'antigravity-cli']) {
    it(`rejects ${platformSource} init and observation outside the selection, including claimed project labels`, async () => {
      for (const cwd of [other, undefined]) {
        const reply = await worker.post('init', { contentSessionId: 'denied', platformSource, cwd, project: 'selected', prompt: 'not captured' });
        expect(reply).toEqual({ skipped: true, reason: 'project_excluded' });
        expect(worker.sessionRows('denied')).toEqual([]);
        const tool = await worker.post('observations', { contentSessionId: 'denied', platformSource, cwd, tool_name: 'Read', tool_input: {}, tool_response: 'not captured', tool_use_id: 'denied-tool' });
        expect(tool).toMatchObject({ status: 'skipped', reason: 'project_excluded' });
        expect(worker.toolUseIds('denied')).toEqual([]);
      }
      expect(worker.generatorStarts).toEqual([]);
    });
  }

  it('captures fresh work in a selected root and stops later events in the same session after removal', async () => {
    const contentSessionId = 'allowed-session';
    await worker.post('init', { contentSessionId, platformSource: 'claude', cwd: root, prompt: 'fresh allowed work' });
    expect(worker.promptTexts(contentSessionId)).toEqual(['fresh allowed work']);
    const reply = await worker.post('observations', { contentSessionId, platformSource: 'claude', cwd: root,
      tool_name: 'Read', tool_input: { file_path: 'a.ts' }, tool_response: 'allowed source', tool_use_id: 'fresh-tool' });
    expect(reply).toEqual({ status: 'queued' });
    const starts = worker.generatorStarts.length;
    process.env.CLAUDE_MEM_INCLUDED_PROJECTS = '[]';
    expect(await worker.post('summarize', { contentSessionId, platformSource: 'claude', last_assistant_message: 'not summarized' }))
      .toEqual({ status: 'skipped', reason: 'project_excluded' });
    expect(await worker.post('init', { contentSessionId, platformSource: 'claude', cwd: root, project: 'selected', prompt: 'not captured' }))
      .toEqual({ skipped: true, reason: 'project_excluded' });
    expect(worker.promptTexts(contentSessionId)).toEqual(['fresh allowed work']);
    expect(worker.generatorStarts.length).toBe(starts);
  });

  it('discards deselected live work at the message boundary and does not replay it after reselection', async () => {
    const id = worker.store.createSDKSession('buffered', 'selected', 'prompt', undefined, 'claude');
    worker.store.setSessionCwd(id, root);
    const manager = new SessionManager(databaseManager() as any);
    manager.initializeSession(id, 'prompt', 1);
    const event = (toolUseId: string) => ({ tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 1, toolUseId, cwd: root });
    manager.queueObservation(id, event('first'));
    manager.queueObservation(id, event('discarded'));
    const iterator = manager.getMessageIterator(id);
    expect((await iterator.next()).done).toBe(false);
    await manager.confirmClaimedMessages(id);
    process.env.CLAUDE_MEM_INCLUDED_PROJECTS = '[]';
    expect((await iterator.next()).done).toBe(true);
    expect(manager.getMessageBuffer().getPendingCount(id)).toBe(0);
    process.env.CLAUDE_MEM_INCLUDED_PROJECTS = JSON.stringify([root]);
    expect(manager.queueObservation(id, event('discarded'))).toBe(0);
    expect(manager.queueObservation(id, event('new-after-reselection'))).toBeGreaterThan(0);
    const fresh = manager.getMessageIterator(id);
    expect((await fresh.next()).value?.toolUseId).toBe('new-after-reselection');
    await fresh.return();
  });

  it('checks project access before generator admission without deleting saved memories', async () => {
    const id = worker.store.createSDKSession('no-start', 'selected', 'prompt', undefined, 'claude');
    worker.store.setSessionCwd(id, root);
    const db = databaseManager();
    const manager = new SessionManager(db as any);
    manager.queueObservation(id, { tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 1, toolUseId: 'held', cwd: root });
    const routes = new SessionRoutes(manager, db as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    process.env.CLAUDE_MEM_INCLUDED_PROJECTS = '[]';
    await routes.ensureGeneratorRunning(id, 'test');
    expect(manager.getMessageBuffer().getPendingCount(id)).toBe(0);
    expect(worker.store.getSessionById(id)).not.toBeNull();
    process.env.CLAUDE_MEM_INCLUDED_PROJECTS = JSON.stringify([root]);
    expect(manager.queueObservation(id, { tool_name: 'Read', tool_input: {}, tool_response: {}, prompt_number: 1, toolUseId: 'held' })).toBe(0);
  });

  it('refuses direct manual saves and context requests without an authorized checkout', async () => {
    const app = express(); app.use(express.json());
    new MemoryRoutes(databaseManager() as any, 'default').setupRoutes(app);
    new SearchRoutes({} as any).setupRoutes(app);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      for (const cwd of [other, undefined]) {
        const save = await fetch(base + '/api/memory/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'not saved', project: 'selected', cwd }) });
        expect(await save.json()).toEqual({ success: false, skipped: true, reason: 'project_excluded' });
        const context = await fetch(base + '/api/context/inject?' + new URLSearchParams({ project: 'selected', ...(cwd ? { cwd } : {}) }));
        expect(await context.text()).toBe('');
      }
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
