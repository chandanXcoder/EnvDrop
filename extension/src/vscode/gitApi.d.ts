// Minimal subset of the built-in vscode.git extension API (vscode/extensions/git/src/api/git.d.ts).
import type { Event, Uri } from 'vscode';

/** Change.status values we care about (mirrors git.d.ts Status enum). */
export type StatusCode = number;

export interface Change {
  readonly uri: Uri;
  readonly originalUri: Uri;
  readonly renameUri: Uri | undefined;
  readonly status: StatusCode;
}

export interface RepositoryState {
  readonly indexChanges: Change[];
  readonly onDidChange: Event<void>;
}

export interface Repository {
  readonly rootUri: Uri;
  readonly state: RepositoryState;
  diffIndexWithHEAD(path: string): Promise<string>;
  /** Unstages the given paths (git reset -q HEAD -- paths). */
  revert(paths: string[]): Promise<void>;
}

export interface API {
  readonly repositories: Repository[];
  readonly onDidOpenRepository: Event<Repository>;
}

export interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): API;
}
