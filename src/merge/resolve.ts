import * as vscode from 'vscode';
import { gitMergeFile } from './mergeUtils';
import { openMergeEditorSmart } from './mergeEditor';
import { markBypassOnce } from './writeBypass';

/** Generic resolver: merge BASE/LOCAL/REMOTE; if conflicts, open the 3-way editor and return the user’s result. */
export async function resolveWithEditorIfNeeded(opts: {
  title: string;
  base: string;
  local: string;
  remote: string;
}): Promise<string> {
  const { merged, conflicts } = await gitMergeFile({
    base: opts.base, local: opts.local, remote: opts.remote
  });
  if (!conflicts) return merged;

  // Conflicted → let the user resolve in the merge editor, return their RESULT
  const mergedText = await openMergeEditorSmart({
    title: opts.title,
    base: opts.base,
    local: opts.local,
    remote: opts.remote,
  });
  return mergedText;
}

/** VFS-aware resolver: on conflicts, opens editor, then writes to destUri using bypass to avoid re-entry. Returns merged text. */
export async function resolveAndWriteForVfs(opts: {
  title: string;
  base: string;
  local: string;
  remote: string;
  destUri: vscode.Uri;                 // virtual FS target
}): Promise<string> {
  const mergedText = await resolveWithEditorIfNeeded({
    title: opts.title,
    base: opts.base,
    local: opts.local,
    remote: opts.remote,
  });

  // Write to virtual file system without retriggering your provider’s conflict path
  const dispose = markBypassOnce(opts.destUri);
  try {
    await vscode.workspace.fs.writeFile(
      opts.destUri, new TextEncoder().encode(mergedText)
    );
  } finally {
    dispose();
  }

  return mergedText;
}
