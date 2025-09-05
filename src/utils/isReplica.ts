import * as vscode from 'vscode';

export async function isReplica(): Promise<boolean> {
    const wf = vscode.workspace.workspaceFolders?.[0];
    if (!wf || wf.uri.scheme !== 'file') return false;

    const settings = vscode.Uri.joinPath(wf.uri, '.overleaf', 'settings.json');
    const baseDir = vscode.Uri.joinPath(wf.uri, '.overleaf', 'base');

    try {
        await vscode.workspace.fs.stat(settings);
        await vscode.workspace.fs.stat(baseDir);
        return true;
    } catch {
        return false;
    }
}
