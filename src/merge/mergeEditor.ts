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
    const baseP   = path.join(dir, `${stem}.BASE.txt`);
    const localP  = path.join(dir, `${stem}.LOCAL.txt`);
    const remoteP = path.join(dir, `${stem}.REMOTE.txt`);
    const resultP = path.join(dir, `${stem}.RESULT.txt`);

    await fs.writeFile(baseP,   normalizeForMerge(opts.base));
    await fs.writeFile(localP,  normalizeForMerge(opts.local));
    await fs.writeFile(remoteP, normalizeForMerge(opts.remote));
    await fs.writeFile(resultP, normalizeForMerge(opts.local)); // seed RESULT with LOCAL

    const resultUri = vscode.Uri.file(resultP);

    // ── Autosave suspension (workspace-scoped) ─────────────────────────────────
    type AutoSave = 'off' | 'afterDelay' | 'onFocusChange' | 'onWindowChange';
    const filesCfg = vscode.workspace.getConfiguration('files');
    const originalAutoSave = filesCfg.get<AutoSave>('autoSave', 'off');
    let restored = false;
    const restoreAutoSave = async () => {
        if (restored) return;
        restored = true;
        try { await filesCfg.update('autoSave', originalAutoSave, vscode.ConfigurationTarget.Workspace); } catch {}
    };
    if (originalAutoSave !== 'off') {
        try { await filesCfg.update('autoSave', 'off', vscode.ConfigurationTarget.Workspace); } catch {}
    }

    // (Optional) soft-guard: nudge if something tries to autosave RESULT anyway.
    const willSaveSub = vscode.workspace.onWillSaveTextDocument(e => {
        if (e.document.uri.fsPath !== resultP) return;
        if (e.reason !== vscode.TextDocumentSaveReason.Manual) {
            vscode.window.showWarningMessage(
                'Autosave is disabled for merge results. Press **Save** when you finish resolving.'
            );
        }
    });

    // Helper to (re)open the merge editor
    async function openMergeEditorOnce() {
        const codeBin = await resolveCodeCli();
        if (codeBin) {
            execFile(codeBin, ['--merge', localP, remoteP, baseP, resultP, '--reuse-window']);
        } else {
            try {
                await vscode.commands.executeCommand('_open.mergeEditor', {
                    title: opts.title,
                    base:   { uri: vscode.Uri.file(baseP),   title: 'Base' },
                    input1: { uri: vscode.Uri.file(localP),  title: 'Current (LOCAL)' },
                    input2: { uri: vscode.Uri.file(remoteP), title: 'Incoming (REMOTE)' },
                    output: { uri: resultUri },
                });
            } catch {
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
        let finished  = false;  // single settle
        let reOpening = false;  // ignore our own reopen close events
        let savedOnce = false;  // track if RESULT was saved

        const disposables: vscode.Disposable[] = [willSaveSub];

        const cleanupTempFiles = () => {
            for (const p of [baseP, localP, remoteP, resultP]) {
                fs.rm(p).catch(() => {});
            }
        };
        const cleanup = async () => {
            disposables.splice(0).forEach(d => d.dispose());
            await restoreAutoSave();
        };

        // SAVE → success path
        disposables.push(
            vscode.workspace.onDidSaveTextDocument(async (doc) => {
                if (finished || doc.uri.fsPath !== resultP) return;
                savedOnce = true;
                finished = true;
                try {
                    const bytes = await vscode.workspace.fs.readFile(resultUri);
                    resolve(new TextDecoder().decode(bytes));
                } finally {
                    await cleanup();
                    cleanupTempFiles();
                }
            })
        );

        // CLOSE → warn, allow return to editor, or cancel (reject)
        disposables.push(
            vscode.workspace.onDidCloseTextDocument(async (doc) => {
                if (finished || reOpening || doc.uri.fsPath !== resultP) return;

                // If they already saved once, just restore autosave and exit quietly.
                if (savedOnce) {
                    finished = true;
                    await cleanup();
                    cleanupTempFiles();
                    return;
                }

                const choice = await vscode.window.showWarningMessage(
                    `You are closing "${opts.title}" without saving the merge result.\n\n` +
                    `If you proceed, conflicting changes may be lost or applied incorrectly.\n\n` +
                    `Do you want to go back and save the RESULT?`,
                    { modal: true },
                    'Return to merge',
                    'Close anyway'
                );

                if (choice === 'Return to merge') {
                    try {
                        reOpening = true;
                        await openMergeEditorOnce();
                    } finally {
                        setTimeout(() => { reOpening = false; }, 200);
                    }
                    return; // keep waiting
                }

                // Close anyway → treat as cancel
                finished = true;
                await cleanup();
                cleanupTempFiles();
                reject(new Error('Merge editor closed without saving'));
            })
        );

        vscode.window.showInformationMessage(
            'Merge editor opened. Autosave is temporarily disabled. Save the RESULT to finish.'
        );
    });
}
