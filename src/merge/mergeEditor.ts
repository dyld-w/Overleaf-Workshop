import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'node:fs/promises';
import { execFile } from 'child_process';
import { execFilePromiseWrapper, normalizeForMerge } from './mergeUtils';

async function resolveCodeCli(): Promise<string | null> {
  const cfg = vscode.workspace.getConfiguration('overleafWorkshop');
  const configured = cfg.get<string>('codeCliPath');
  if (configured) return configured;
  const cands = process.platform === 'win32'
    ? ['code.cmd', 'code-insiders.cmd', 'C:\\Program Files\\Microsoft VS Code\\bin\\code.cmd']
    : ['code', 'code-insiders'];
  for (const c of cands) { try { await execFilePromiseWrapper(c, ['-v']); return c; } catch {} }
  return null;
}

export async function openMergeEditorSmart(opts: {
  title: string; base: string; local: string; remote: string;
}): Promise<string> {
  const dir  = path.join(os.tmpdir(), 'overleaf-merge');
  await fs.mkdir(dir, { recursive: true });
  const stem = opts.title.replace(/[\/\\]/g, '__');
  const baseP   = path.join(dir, `${stem}.BASE.txt`);
  const localP  = path.join(dir, `${stem}.LOCAL.txt`);
  const remoteP = path.join(dir, `${stem}.REMOTE.txt`);
  const resultP = path.join(dir, `${stem}.RESULT.txt`);
  await fs.writeFile(baseP, normalizeForMerge(opts.base));
  await fs.writeFile(localP, normalizeForMerge(opts.local));
  await fs.writeFile(remoteP, normalizeForMerge(opts.remote));
  await fs.writeFile(resultP, normalizeForMerge(opts.local));

  const codeBin = await resolveCodeCli();
  if (codeBin) {
    execFile(codeBin, ['--merge', localP, remoteP, baseP, resultP, '--reuse-window']);
  } else {
    // fallback to internal command if available
    try {
      const baseUri   = vscode.Uri.file(baseP);
      const localUri  = vscode.Uri.file(localP);
      const remoteUri = vscode.Uri.file(remoteP);
      const resultUri = vscode.Uri.file(resultP);
      await vscode.commands.executeCommand('_open.mergeEditor', {
        title: opts.title,
        base: { uri: baseUri, title: 'Base' },
        input1: { uri: localUri, title: 'Current (LOCAL)' },
        input2: { uri: remoteUri, title: 'Incoming (REMOTE)' },
        output: { uri: resultUri },
      });
    } catch {
      await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(localP), vscode.Uri.file(remoteP), `Resolve ${opts.title}`);
    }
  }

  return new Promise<string>((resolve) => {
    const resultUri = vscode.Uri.file(resultP);
    const sub = vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (doc.uri.fsPath !== resultP) return;
      sub.dispose();
      const bytes = await vscode.workspace.fs.readFile(resultUri);
      resolve(new TextDecoder().decode(bytes));
      // best-effort cleanup
      for (const p of [baseP, localP, remoteP, resultP]) fs.rm(p).catch(() => {});
    });
    vscode.window.showInformationMessage('Merge editor opened. Save the RESULT to finish.');
  });
}
