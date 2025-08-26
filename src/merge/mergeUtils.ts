import { execFile } from 'child_process';
import { writeTempFile, deleteTempFiles } from './tempFiles';

/** Exec wrapper that treats `git merge-file` exit code 1 (conflicts) as non-fatal. */
export function execFilePromiseWrapper(cmd: string, args: string[], opts: any = {}): Promise<{ stdout: string; code: number }> {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { maxBuffer: 10 * 1024 * 1024, ...opts }, (err, stdout) => {
            const code = (err as any)?.code ?? 0;
            if (err && code !== 1) return reject(err); // real error
            resolve({ stdout: String(stdout), code }); // code === 1 => conflicts
        });
    });
}

/** Normalize like Git (LF endings + NFC) to reduce bogus diffs. */
export function normalizeForMerge(s: string): string {
    return s.replace(/\r\n/g, '\n').normalize('NFC');
}

/** Generate a short unique id for temp file names. */
export function uniqueId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function gitMergeFile(opts: {
    base: string;
    local: string;
    remote: string;
}): Promise<{ merged: string; conflicts: boolean }> {
    const baseUri = await writeTempFile(`BASE-${Date.now()}`, normalizeForMerge(opts.base));
    const localUri = await writeTempFile(`LOCAL-${Date.now()}`, normalizeForMerge(opts.local));
    const remoteUri = await writeTempFile(`REMOTE-${Date.now()}`, normalizeForMerge(opts.remote));
    try {
        const { stdout, code } = await execFilePromiseWrapper('git', [
            'merge-file', '-p',
            '-L', 'LOCAL', '-L', 'BASE', '-L', 'REMOTE',
            localUri.fsPath, baseUri.fsPath, remoteUri.fsPath,
        ]);
        return { merged: String(stdout), conflicts: code === 1 };
    } finally {
        await deleteTempFiles([baseUri, localUri, remoteUri]);
    }
}
