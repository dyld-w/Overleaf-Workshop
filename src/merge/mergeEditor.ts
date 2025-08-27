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
    for (const c of cands) { try { await execFilePromiseWrapper(c, ['-v']); return c; } catch { } }
    return null;
}

export async function openMergeEditorSmart(opts: {
    title: string; base: string; local: string; remote: string;
}): Promise<string> {
    const dir = path.join(os.tmpdir(), 'overleaf-merge');
    await fs.mkdir(dir, { recursive: true });
    const stem = opts.title.replace(/[\/\\]/g, '__');
    const baseP = path.join(dir, `${stem}.BASE.txt`);
    const localP = path.join(dir, `${stem}.LOCAL.txt`);
    const remoteP = path.join(dir, `${stem}.REMOTE.txt`);
    const resultP = path.join(dir, `${stem}.RESULT.txt`);

    await fs.writeFile(baseP, normalizeForMerge(opts.base));
    await fs.writeFile(localP, normalizeForMerge(opts.local));
    await fs.writeFile(remoteP, normalizeForMerge(opts.remote));
    await fs.writeFile(resultP, normalizeForMerge(opts.local)); // seed RESULT with LOCAL

    const resultUri = vscode.Uri.file(resultP);

    // Helper to (re)open the merge editor
    async function openMergeEditorOnce() {
        const codeBin = await resolveCodeCli();
        if (codeBin) {
            // External VS Code instance (or same, via --reuse-window)
            execFile(codeBin, ['--merge', localP, remoteP, baseP, resultP, '--reuse-window']);
        } else {
            // Internal fallback
            try {
                await vscode.commands.executeCommand('_open.mergeEditor', {
                    title: opts.title,
                    base: { uri: vscode.Uri.file(baseP), title: 'Base' },
                    input1: { uri: vscode.Uri.file(localP), title: 'Current (LOCAL)' },
                    input2: { uri: vscode.Uri.file(remoteP), title: 'Incoming (REMOTE)' },
                    output: { uri: resultUri },
                });
            } catch {
                // Last-ditch fallback: diff view
                await vscode.commands.executeCommand(
                    'vscode.diff',
                    vscode.Uri.file(localP),
                    vscode.Uri.file(remoteP),
                    `Resolve ${opts.title}`
                );
            }
        }
    }

    await openMergeEditorOnce();

    return new Promise<string>((resolve, reject) => {
        let finished = false;      // guarantees single resolve/reject
        let reOpening = false;     // ignore close events caused by our own reopen
        let savedOnce = false;     // track if RESULT was ever saved

        const disposables: vscode.Disposable[] = [];

        function cleanupTempFiles() {
            for (const p of [baseP, localP, remoteP, resultP]) {
                fs.rm(p).catch(() => { /* ignore */ });
            }
        }

        function cleanup() {
            disposables.splice(0).forEach(d => d.dispose());
        }

        // SAVE → success path
        disposables.push(
            vscode.workspace.onDidSaveTextDocument(async (doc) => {
                if (finished) return;
                if (doc.uri.fsPath !== resultP) return;
                savedOnce = true;
                finished = true;
                cleanup();
                try {
                    const bytes = await vscode.workspace.fs.readFile(resultUri);
                    resolve(new TextDecoder().decode(bytes));
                } finally {
                    cleanupTempFiles();
                }
            })
        );

        // CLOSE → intercept and offer to return or discard
        disposables.push(
            vscode.workspace.onDidCloseTextDocument(async (doc) => {
                if (finished) return;
                if (reOpening) return;                       // ignore our own reopen
                if (doc.uri.fsPath !== resultP) return;      // only care about RESULT

                // If they already saved once, allow close silently (we're likely resolved).
                if (savedOnce) return;

                // Show modal warn with choices
                const choice = await vscode.window.showWarningMessage(
                    `You are closing "${opts.title}" without saving the merge result.\n\n` +
                    `If you proceed, conflicting changes may be lost or applied incorrectly.\n\n` +
                    `Do you want to go back and save the RESULT?`,
                    { modal: true },
                    'Return to merge',
                    'Close anyway'
                );

                if (choice === 'Return to merge') {
                    // Re-open the merge editor and keep waiting for save/close again
                    try {
                        reOpening = true;
                        await openMergeEditorOnce();
                    } finally {
                        // small delay to avoid racing the just-opened editor’s lifecycle
                        setTimeout(() => { reOpening = false; }, 200);
                    }
                    return; // keep the promise pending
                }

                // Close anyway → treat as cancel/abort
                finished = true;
                cleanup();
                cleanupTempFiles();
                reject(new Error('Merge editor closed without saving'));
            })
        );

        vscode.window.showInformationMessage(
            'Merge editor opened. Save the RESULT to finish.'
        );
    });
}