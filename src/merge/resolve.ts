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

// NEW: small helper – always write to the same scheme as the merge-result buffer
// function pickDestFromResult(resultDoc: vscode.TextDocument): vscode.Uri {
//   const u = resultDoc.uri;
//   if (u.scheme === 'overleaf' || u.scheme === 'file') return u;
//   throw new Error(`Unexpected scheme for merge result: ${u.toString()}`);
// }

// export async function resolveAndWriteFromMergeResult(
//   mergedText: string,
//   resultDoc: vscode.TextDocument
// ): Promise<void> {
//   const destUri = pickDestFromResult(resultDoc);
//   const payload = new TextEncoder().encode(mergedText);

//   // Keep bypass scoped to only this write to avoid muting the sync queue
//   const disposeBypass = markBypassOnce(destUri);
//   try {
//     console.log('[merge] writeFile ->', destUri.toString(), 'len=', payload.byteLength);
//     await Promise.race([
//       vscode.workspace.fs.writeFile(destUri, payload),
//       new Promise((_, rej) => setTimeout(() => rej(new Error('writeFile timeout')), 8000)),
//     ]);
//     console.log('[merge] writeFile OK for', destUri.toString());
//   } catch (e) {
//     console.error('[merge] writeFile FAILED for', destUri.toString(), e);
//     throw e;
//   } finally {
//     disposeBypass();
//   }
// }

// /** VFS-aware resolver: on conflicts, opens editor, then writes to destUri using bypass to avoid re-entry. Returns merged text. */
// export async function resolveAndWriteForVfs(opts: {
//     title: string;
//     base: string;
//     local: string;
//     remote: string;
//     destUri: vscode.Uri;                 // virtual FS target
// }): Promise<string> {
//     console.log("MAKES IT INTO RESOLVE AND WRITE FOR VFS");
//     const mergedText = await resolveWithEditorIfNeeded({
//         title: opts.title,
//         base: opts.base,
//         local: opts.local,
//         remote: opts.remote,
//     });

//     // console.log("MERGEDTEXT: ", mergedText);

//     // Write to virtual file system without retriggering your provider’s conflict path
//     const dispose = markBypassOnce(opts.destUri);
//     try {
//         console.log("FS WRITEFILE TO", opts.destUri);
//         await vscode.workspace.fs.writeFile(
//             opts.destUri, new TextEncoder().encode(mergedText)
//         );
//     } finally {
//         dispose();
//     }

//     return mergedText;
// }
