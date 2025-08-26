import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { TEMP_DIR_NAME } from './constants';

// ======================================================
// Shared temp utils + merge write bypass (re-entrancy guard)
// ======================================================

/** Bypass set so the FS provider ignores the write we do after RESULT save. */
const MERGE_WRITE_BYPASS = new Set<string>();

/** Encode a string to UTF-8 bytes. */
function encodeText(text: string): Uint8Array {
    return new TextEncoder().encode(text);
}

/** Return the VS Code URI for the single temp directory, creating it if needed. */
export async function getTempDirUri(): Promise<vscode.Uri> {
    const tmpRootPath = path.join(os.tmpdir(), TEMP_DIR_NAME);
    const tmpRootUri = vscode.Uri.file(tmpRootPath);
    await vscode.workspace.fs.createDirectory(tmpRootUri);
    return tmpRootUri;
}

/** Write a string to a temp file under the single temp directory. */
export async function writeTempFile(filename: string, contents: string): Promise<vscode.Uri> {
    const tmpRootUri = await getTempDirUri();
    const fileUri = vscode.Uri.file(path.join(tmpRootUri.fsPath, filename));
    await vscode.workspace.fs.writeFile(fileUri, encodeText(contents));
    return fileUri;
}

/** Delete a list of temp files, ignoring errors. */
export async function deleteTempFiles(uris: vscode.Uri[]): Promise<void> {
    await Promise.all(uris.map(u => Promise.resolve(vscode.workspace.fs.delete(u)).catch(() => { })));
}