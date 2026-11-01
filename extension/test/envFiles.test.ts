import { describe, expect, it } from 'vitest';
import { isShareableEnvFile, safeIncomingName } from '../src/core/envFiles';

describe('env file helpers', () => {
  it('identifies shareable env files', () => {
    expect(isShareableEnvFile('/x/.env')).toBe(true);
    expect(isShareableEnvFile('.env.production')).toBe(true);
    expect(isShareableEnvFile('.env.example')).toBe(false);
    expect(isShareableEnvFile('.env.backup')).toBe(false);
    expect(isShareableEnvFile('index.ts')).toBe(false);
  });
  it('sanitises incoming filenames (no path traversal)', () => {
    expect(safeIncomingName('../../.bashrc')).toBe('.env');
    expect(safeIncomingName('..\\..\\.env.production')).toBe('.env.production');
    expect(safeIncomingName('/etc/passwd')).toBe('.env');
    expect(safeIncomingName('.env.staging')).toBe('.env.staging');
  });
});
