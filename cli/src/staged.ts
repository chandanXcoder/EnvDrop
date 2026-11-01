import { defaultGitRunner, type GitRunner } from '@envdrop/core';
import { scanUnifiedDiff, type SecretFinding, sensitiveFilenameReason } from '@envdrop/shared';
import ignore from 'ignore';

export interface StagedReport {
  file: string;
  filenameReason?: string;
  findings: SecretFinding[];
}

/** Scans what `git commit` would include: staged filenames + added lines. */
export async function scanStaged(
  cwd: string,
  opts: { git?: GitRunner; ignorePatterns?: string[] } = {},
): Promise<StagedReport[]> {
  const git = opts.git ?? defaultGitRunner;
  const top = await git(['rev-parse', '--show-toplevel'], cwd);
  if (top.code !== 0) throw new Error('Not inside a git repository.');
  const root = top.stdout.trim();
  const names = await git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], root);
  const ig = ignore().add(opts.ignorePatterns ?? []);
  const files = names.stdout.split('\0').filter((f) => f && !ig.ignores(f));
  const out: StagedReport[] = [];
  for (const file of files) {
    const filenameReason = sensitiveFilenameReason(file);
    const diff = await git(
      ['diff', '--cached', '--no-color', '--no-ext-diff', '-U0', '--', file],
      root,
    );
    const findings = diff.stdout.length <= 512 * 1024 ? scanUnifiedDiff(diff.stdout) : [];
    if (filenameReason || findings.length) out.push({ file, filenameReason, findings });
  }
  return out;
}
