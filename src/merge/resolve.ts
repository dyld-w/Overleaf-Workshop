import { gitMergeFile } from './mergeUtils';
import { openMergeEditorSmart } from './mergeEditor';

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
