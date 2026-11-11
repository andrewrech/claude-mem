
import { basename, isAbsolute, relative, sep } from 'path';
import { realpathSync, statSync } from 'node:fs';
import { expandHome } from '../shared/expand-home.js';
import { logger } from './logger.js';

function globToRegex(pattern: string): RegExp {
  // Separators first, then home expansion. A pattern written on Windows as `~\projects\secret`
  // is home-relative, but `expandHome` only recognises `~` and `~/` on POSIX — resolving
  // another user's home is deliberately out of its scope. Expanding before normalising left
  // that pattern as a literal `~/projects/secret`, which matches no absolute path, so a
  // configured exclusion silently stopped excluding.
  let expanded = expandHome(pattern.replace(/\\/g, '/'));

  // Again on the way out: on Windows `homedir()` itself returns backslashes, so the
  // expanded path needs normalising even when the pattern arrived POSIX-form.
  expanded = expanded.replace(/\\/g, '/');

  let regex = expanded.replace(/[.+^${}()|[\]\\]/g, '\\$&');

  regex = regex
    // A complete **/ directory segment also matches no directory. Keep its
    // slash until after tokenization so consecutive globstars are recognized.
    .replace(/(^|\/)\*\*(?=\/)/g, '$1<<<GLOBSTAR_DIR>>>')
    .replace(/\*\*/g, '<<<GLOBSTAR>>>')  
    .replace(/\*/g, '[^/]*')              
    .replace(/\?/g, '[^/]')               
    .replace(/<<<GLOBSTAR>>>/g, '.*')
    .replace(/<<<GLOBSTAR_DIR>>>\//g, '(?:.*/)?');

  return new RegExp(`^${regex}$`);
}

/**
 * `dir/**` means "everything under dir" and users also expect it to cover `dir`
 * itself, but the regex needs a character after `dir/`. Match the pattern with
 * its trailing `/**` removed against the path as well.
 */
function matchesGlobPattern(pattern: string, normalizedPath: string, pathBasename: string): boolean {
  const regex = globToRegex(pattern);
  if (regex.test(normalizedPath) || regex.test(pathBasename)) return true;
  if (pattern.replace(/\\/g, '/').endsWith('/**')) {
    return globToRegex(pattern.slice(0, -3)).test(normalizedPath.replace(/\/+$/, ''));
  }
  return false;
}

/**
 * Returns true when `folderPath` matches any of the supplied glob patterns.
 * Patterns support `*`, `**`, `?`, and a leading `~`. Matches against both the
 * full normalized path and the basename. Reuses the same glob semantics as
 * project exclusion. Used by the skeleton-CLAUDE.md deny-list (#2400).
 */
export function matchesAnyGlob(folderPath: string, patterns: string[]): boolean {
  if (!patterns.length) return false;
  const normalizedPath = folderPath.replace(/\\/g, '/');
  const pathBasename = basename(normalizedPath);
  for (const rawPattern of patterns) {
    const pattern = rawPattern.trim();
    if (!pattern) continue;
    try {
      if (matchesGlobPattern(pattern, normalizedPath, pathBasename)) {
        return true;
      }
    } catch (error: unknown) {
      logger.warn('PROJECT_NAME', 'Invalid glob pattern', { pattern, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
  }
  return false;
}

export function isProjectExcluded(projectPath: string, exclusionPatterns: string): boolean {
  if (!exclusionPatterns || !exclusionPatterns.trim()) {
    return false;
  }

  const normalizedProjectPath = projectPath.replace(/\\/g, '/');
  const projectBasename = basename(normalizedProjectPath);

  const patternList = exclusionPatterns
    .split(',')
    .map(p => p.trim())
    .filter(Boolean);

  for (const pattern of patternList) {
    try {
      if (matchesGlobPattern(pattern, normalizedProjectPath, projectBasename)) {
        return true;
      }
    } catch (error: unknown) {
      logger.warn('PROJECT_NAME', 'Invalid exclusion pattern', { pattern, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
  }

  return false;
}

/**
 * An optional root allowlist for automatic capture and agent memory tools.
 * Unset preserves the upstream exclusion-only policy; an explicit JSON []
 * allows no projects. A configured policy never guesses a missing checkout
 * from a project label. Real paths prevent sibling-prefix and symlink escapes.
 */
export function isProjectAllowed(
  cwd: string | null | undefined,
  exclusionPatterns: string = '',
  includedProjects: unknown = '',
): boolean {
  if (includedProjects === undefined || (typeof includedProjects === 'string' && includedProjects.trim() === '')) {
    return !cwd || !isProjectExcluded(cwd, exclusionPatterns);
  }
  if (typeof includedProjects !== 'string' || !cwd || !isAbsolute(cwd)) return false;
  try {
    const roots: unknown = JSON.parse(includedProjects);
    if (!Array.isArray(roots) || roots.length > 256 || roots.some(root => typeof root !== 'string' || !isAbsolute(root))) return false;
    const realCwd = realpathSync.native(cwd);
    if (!statSync(realCwd).isDirectory()
      || isProjectExcluded(cwd, exclusionPatterns)
      || isProjectExcluded(realCwd, exclusionPatterns)) return false;
    return roots.some(root => {
      try {
        const realRoot = realpathSync.native(root);
        if (!statSync(realRoot).isDirectory()) return false;
        const child = relative(realRoot, realCwd);
        return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
      } catch { return false; }
    });
  } catch { return false; }
}
