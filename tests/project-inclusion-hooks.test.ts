import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookCommand, buildNoOpResult } from '../src/cli/hook-command.js';
import { getPlatformAdapter } from '../src/cli/adapters/index.js';
import { getEventHandler } from '../src/cli/handlers/index.js';
import { SettingsDefaultsManager } from '../src/shared/SettingsDefaultsManager.js';
import { resetHookSettingsCacheForTesting } from '../src/shared/hook-settings.js';
import { installFakeStdin, restoreStdin } from './fake-stdin.js';

let directory: string, selected: string, other: string;
const realStdoutWrite = process.stdout.write;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'cmem-hook-policy-'));
  selected = join(directory, 'selected'); other = join(directory, 'other');
  mkdirSync(selected); mkdirSync(other);
  resetHookSettingsCacheForTesting();
  process.stdout.write = ((_chunk: unknown, callback: () => void) => { callback?.(); return true; }) as typeof process.stdout.write;
});
afterEach(() => {
  restoreStdin(); process.stdout.write = realStdoutWrite;
  resetHookSettingsCacheForTesting();
  rmSync(directory, { recursive: true, force: true });
});

describe('native project opt-in before transcript normalization', () => {
  for (const platform of ['claude-code', 'codex', 'kimi', 'antigravity-cli']) {
    it(`gates ${platform} context and capture before its adapter reads source data`, async () => {
      const settings = spyOn(SettingsDefaultsManager, 'loadFromFile').mockReturnValue({
        ...SettingsDefaultsManager.getAllDefaults(), CLAUDE_MEM_INCLUDED_PROJECTS: JSON.stringify([selected]),
        CLAUDE_MEM_EXCLUDED_PROJECTS: '', CLAUDE_MEM_OBSERVER_ENABLED: 'true',
      });
      const adapter = spyOn(getPlatformAdapter(platform), 'normalizeInput');
      try {
        for (const event of ['context', 'session-init', 'file-context', 'observation', 'summarize']) {
          const handler = spyOn(getEventHandler(event), 'execute').mockResolvedValue(buildNoOpResult(event));
          try {
            for (const cwd of [other, undefined]) {
              installFakeStdin(JSON.stringify({ session_id: 'policy-fixture', conversationId: 'policy-fixture', cwd,
                ...(platform === 'antigravity-cli' && cwd ? { workspacePaths: [cwd] } : {}),
                transcript_path: '/must-not-read', transcriptPath: '/must-not-read' }));
              expect(await hookCommand(platform, event, { skipExit: true })).toBe(0);
            }
            expect(handler).not.toHaveBeenCalled();
          } finally { handler.mockRestore(); }
        }
        expect(adapter).not.toHaveBeenCalled();
        const handler = spyOn(getEventHandler('context'), 'execute').mockResolvedValue(buildNoOpResult('context'));
        try {
          installFakeStdin(JSON.stringify({ session_id: 'policy-fixture', conversationId: 'policy-fixture', cwd: selected,
            ...(platform === 'antigravity-cli' ? { workspacePaths: [selected] } : {}) }));
          expect(await hookCommand(platform, 'context', { skipExit: true })).toBe(0);
          expect(handler).toHaveBeenCalledTimes(1);
        } finally { handler.mockRestore(); }
      } finally { adapter.mockRestore(); settings.mockRestore(); }
    });
  }
});
