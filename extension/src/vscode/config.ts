import * as vscode from 'vscode';
import { EXPIRY_OPTIONS, type ExpiryOption, MAX_VIEWS, MIN_VIEWS } from '@envdrop/shared';

export const DEFAULT_SERVER_URL = 'https://envdrop.example.workers.dev';

export function cfg() {
  const c = vscode.workspace.getConfiguration('envdrop');
  const expiry = c.get<string>('defaultExpiry', '1h');
  const views = c.get<number>('defaultMaxViews', 1);
  return {
    serverUrl: c.get<string>('serverUrl', DEFAULT_SERVER_URL) || DEFAULT_SERVER_URL,
    defaultExpiry: (expiry in EXPIRY_OPTIONS ? expiry : '1h') as ExpiryOption,
    defaultMaxViews: Math.min(MAX_VIEWS, Math.max(MIN_VIEWS, Math.floor(views) || 1)),
    checkGitignoreOnOpen: c.get<boolean>('checkGitignoreOnOpen', true),
    precommitEnabled: c.get<boolean>('precommit.enabled', true),
    precommitScanContent: c.get<boolean>('precommit.scanContent', true),
    precommitIgnorePatterns: c.get<string[]>('precommit.ignorePatterns', []),
  };
}

export const EXPIRY_LABELS: Record<ExpiryOption, string> = {
  '10m': '10 minutes',
  '1h': '1 hour',
  '24h': '24 hours',
};
