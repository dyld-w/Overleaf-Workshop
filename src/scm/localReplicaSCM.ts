import * as vscode from 'vscode';
import { minimatch } from 'minimatch';
import { BaseSCM, CommitItem, SettingItem } from ".";
import { VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
import * as merge from '../merge';
import { ActiveReplica } from "../utils/activeReplica";
import { isReplica } from '../utils/isReplica';

const IGNORE_SETTING_KEY = 'ignore-patterns';

/** How to resolve true binary conflicts (when all three differ and neither equals BASE). */
type BinaryStrategy = 'prefer-remote' | 'prefer-local';
const BINARY_CONFLICT_STRATEGY: BinaryStrategy = 'prefer-remote';

type FileCache = { date: number, hash: number };

/**
 * Returns a hash code from a string
 * @param  {String} str The string to hash.
 * @return {Number}    A 32bit integer
 * @see http://werxltd.com/wp/2010/05/13/javascript-implementation-of-javas-string-hashcode-method/
 */
function hashCode(content?: Uint8Array): number {
    if (content === undefined) { return -1; }
    const str = new TextDecoder().decode(content);

    let hash = 0;
    for (let i = 0, len = str.length; i < len; i++) {
        const chr = str.charCodeAt(i);
        hash = (hash << 5) - hash + chr;
        hash |= 0; // Convert to 32bit integer
    }
    return hash;
}

/** Heuristic: treat file as binary if any NUL is present or a high ratio of control chars exists. */
function isProbablyBinary(bytes?: Uint8Array): boolean {
    if (!bytes) return false;
    const sampleLen = Math.min(bytes.length, 8192);
    let ctrl = 0;
    for (let i = 0; i < sampleLen; i++) {
        const b = bytes[i];
        if (b === 0x00) return true;                           // NUL byte → very likely binary
        // Count non-whitespace ASCII control chars (exclude \t, \r, \n)
        if ((b < 0x20 && b !== 0x09 && b !== 0x0A && b !== 0x0D)) ctrl++;
    }
    // If more than ~30% of the sample are control chars, call it binary.
    return ctrl / sampleLen > 0.30;
}

/**
 * A SCM which tracks exact the changes from the vfs.
 * It keeps no history versions.
 */
export class LocalReplicaSCMProvider extends BaseSCM {
    public static readonly label = vscode.l10n.t('Local Replica');

    public readonly iconPath: vscode.ThemeIcon = new vscode.ThemeIcon('folder-library');

    private bypassCache: Map<string, [FileCache, FileCache]> = new Map();
    private baseCache: { [key: string]: Uint8Array } = {};
    private vfsWatcher?: vscode.FileSystemWatcher;
    private localWatcher?: vscode.FileSystemWatcher;
    private ignorePatterns: string[] = [
        '**/.*',
        '**/.*/**',
        '**/*.aux',
        '**/*.bbl',
        '**/*.bcf',
        '**/*.blg',
        '**/*.fdb_latexmk',
        '**/*.fls',
        '**/*.git',
        '**/*.lof',
        '**/*.log',
        '**/*.lot',
        '**/*.out',
        '**/*.run.xml',
        '**/*.synctex(busy)',
        '**/*.synctex.gz',
        '**/*.toc',
        '**/*.xdv',
        '**/main.pdf',
        '**/output.pdf',
        '.vscode/**'
    ];

    public wasOffline = false;
    public offlineModalShown = false;
    public resolveOfflineNotice?: () => void; // call to close the sticky notice
    private syncSuspended = false;              // gate watchers during bulk reconcile
    private bulkInFlight?: Promise<void>;       // debounce concurrent runs

    constructor(
        protected readonly vfs: VirtualFileSystem,
        public readonly baseUri: vscode.Uri,
    ) {
        super(vfs, baseUri);
        ActiveReplica.set(this);
    }

    public static async validateBaseUri(uri: string, projectName?: string): Promise<vscode.Uri> {
        try {
            let baseUri = vscode.Uri.file(uri);
            // check if the path exists
            try {
                const stat = await vscode.workspace.fs.stat(baseUri);
                if (stat.type !== vscode.FileType.Directory) {
                    throw new Error('Not a folder');
                }
                // check if the project name is included in the path
                if (projectName !== undefined && !baseUri.path.endsWith(`/${projectName}`)) {
                    baseUri = vscode.Uri.joinPath(baseUri, projectName);
                }
            } catch {
                // keep the baseUri as is
            }
            // try to create the folder with `mkdirp` semantics
            await vscode.workspace.fs.createDirectory(baseUri);
            await vscode.workspace.fs.stat(baseUri);
            return baseUri;
        } catch (error) {
            vscode.window.showErrorMessage(vscode.l10n.t('Invalid Path. Please make sure the absolute path to a folder with read/write permissions is used.'));
            return Promise.reject(error);
        }
    }

    public static async pathToUri(path: string): Promise<vscode.Uri | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (workspaceRoot === undefined || workspaceRoot?.scheme !== 'file') { return undefined; }

        const settingUri = vscode.Uri.joinPath(workspaceRoot, '.overleaf/settings.json');
        try {
            await vscode.workspace.fs.stat(settingUri);
            return vscode.Uri.joinPath(workspaceRoot, path);
        } catch (error) {
            return undefined;
        }
    }

    public static async uriToPath(uri: vscode.Uri): Promise<string | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (workspaceRoot === undefined || workspaceRoot?.scheme !== 'file') { return undefined; }

        const settingUri = vscode.Uri.joinPath(workspaceRoot, '.overleaf/settings.json');
        try {
            await vscode.workspace.fs.stat(settingUri);
            return uri.path.slice(workspaceRoot.path.length);
        } catch (error) {
            return undefined;
        }
    }

    public static async readSettings(): Promise<any | undefined> {
        const workspaceRoot = vscode.workspace.workspaceFolders?.[0].uri;
        if (vscode.workspace.workspaceFolders?.length !== 1 || workspaceRoot?.scheme !== 'file') { return undefined; }

        const settingUri = vscode.Uri.joinPath(workspaceRoot, '.overleaf/settings.json');
        try {
            await vscode.workspace.fs.stat(settingUri);
            const content = await vscode.workspace.fs.readFile(settingUri);
            return JSON.parse(new TextDecoder().decode(content));
        } catch (error) {
            return undefined;
        }
    }

    private matchIgnorePatterns(path: string): boolean {
        const ignorePatterns = this.getSetting<string[]>(IGNORE_SETTING_KEY) || this.ignorePatterns;
        for (const pattern of ignorePatterns) {
            if (minimatch(path, pattern, { dot: true })) {
                return true;
            }
        }
        return false;
    }

    private setBypassCache(relPath: string, content?: Uint8Array, action?: 'push' | 'pull') {
        const date = Date.now();
        const hash = hashCode(content);
        const cache = this.bypassCache.get(relPath) || [undefined, undefined];
        // update the push/pull cache
        if (action === 'push') {
            cache[0] = { date, hash };
            cache[1] = cache[1] ?? { date, hash };
        } else if (action === 'pull') {
            cache[1] = { date, hash };
            cache[0] = cache[0] ?? { date, hash };
        } else {
            cache[0] = { date, hash };
            cache[1] = { date, hash };
        }
        // write back to the cache
        this.bypassCache.set(relPath, cache as [FileCache, FileCache]);
    }

    private shouldPropagate(action: 'push' | 'pull', relPath: string, content?: Uint8Array): boolean {
        const now = Date.now();
        const cache = this.bypassCache.get(relPath);
        if (cache) {
            const thisHash = hashCode(content);
            // console.log(action, relPath, `[${cache[0].hash}, ${cache[1].hash}]`, thisHash);
            if (action === 'push' && cache[0].hash === thisHash) { return false; }
            if (action === 'pull' && cache[1].hash === thisHash) { return false; }
            if (cache[0].hash !== cache[1].hash) {
                if ((action === 'push' && now - cache[0].date < 500) || (action === 'pull' && now - cache[1].date < 500)) {
                    this.setBypassCache(relPath, content, action);
                    return true;
                }
                this.setBypassCache(relPath, content, action);
                return false;
            }
        }
        this.setBypassCache(relPath, content, action);
        return true;
    }

    private bypassSync(action: 'push' | 'pull', type: 'update' | 'delete', relPath: string, content?: Uint8Array): boolean {
        // bypass ignore files
        if (this.matchIgnorePatterns(relPath)) {
            return true;
        }
        // synchronization propagation check
        if (!this.shouldPropagate(action, relPath, content)) {
            return true;
        }
        // otherwise, log the synchronization
        console.log(`${new Date().toLocaleString()} [${action}] ${type} "${relPath}"`);
        return false;
    }

    private async applySync(action: 'push' | 'pull', type: 'update' | 'delete', relPath: string, fromUri: vscode.Uri, toUri: vscode.Uri) {
        this.status = { status: action, message: `${type}: ${relPath}` };
        console.log("APPLYSYNC")

        await (async () => {
            if (type === 'delete') {
                const newContent = undefined;
                if (this.bypassSync(action, type, relPath, newContent)) { return; }
                delete this.baseCache[relPath];
                await this.deleteBaseSnapshot(relPath);                // ✨ persist delete
                await vscode.workspace.fs.delete(toUri, { recursive: true });
            } else {
                const stat = await vscode.workspace.fs.stat(fromUri);
                if (stat.type === vscode.FileType.Directory) {
                    const newContent = new Uint8Array();
                    if (this.bypassSync(action, type, relPath, newContent)) { return; }
                    await vscode.workspace.fs.createDirectory(toUri);
                }
                else if (stat.type === vscode.FileType.File) {
                    try {
                        const newContent = await vscode.workspace.fs.readFile(fromUri);
                        if (this.bypassSync(action, type, relPath, newContent)) { return; }
                        await vscode.workspace.fs.writeFile(toUri, newContent);
                        this.baseCache[relPath] = newContent;          // ✨ advance BASE
                        await this.writeBaseSnapshot(relPath, newContent); // ✨ persist BASE
                        if (action === 'push') { await vscode.workspace.fs.readFile(toUri); } // update remote cache
                    } catch (error) {
                        console.error(error);
                    }
                }
                else {
                    console.error(`Unknown file type: ${stat.type}`);
                }
            }
        })();

        this.status = { status: 'idle', message: '' };
    }

    // --- Paths/helpers ----------------------------------------------------------
    private baseStoreRoot(): vscode.Uri {
        return vscode.Uri.joinPath(this.baseUri, '.overleaf', 'base');
    }
    private conflictsRoot(): vscode.Uri {
        return vscode.Uri.joinPath(this.baseUri, '.overleaf', 'conflicts');
    }
    private relSegments(relPath: string): string[] {
        const rel = relPath.startsWith('/') ? relPath.slice(1) : relPath;
        return rel ? rel.split('/') : [];
    }
    private baseSnapUri(relPath: string): vscode.Uri {
        const segments = this.relSegments(relPath);
        return vscode.Uri.joinPath(this.baseStoreRoot(), ...segments);
    }
    private baseSnapDirUri(relPath: string): vscode.Uri {
        const segments = this.relSegments(relPath);
        segments.pop(); // parent only
        return vscode.Uri.joinPath(this.baseStoreRoot(), ...segments);
    }
    private conflictArtifactUri(relPath: string, suffix: 'LOCAL' | 'REMOTE' | 'BASE'): vscode.Uri {
        const segments = this.relSegments(relPath);
        const file = segments.pop() ?? 'file';
        const parent = vscode.Uri.joinPath(this.conflictsRoot(), ...segments);
        return vscode.Uri.joinPath(parent, `${file}.${suffix}`);
    }

    // --- Helper: only snapshot files that aren't ignored -------------------------
    /** Return true iff this file should be snapshotted (i.e., not ignored). */
    private shouldSnapshot(relPath: string): boolean {
        return !this.matchIgnorePatterns(relPath);
    }

    // --- Disk I/O for BASE snapshots (now honoring ignore patterns) --------------
    private async ensureBaseStore(): Promise<void> {
        try { await vscode.workspace.fs.createDirectory(this.baseStoreRoot()); } catch { /* noop */ }
    }
    private async ensureConflictsStore(relPath: string): Promise<void> {
        const segments = this.relSegments(relPath);
        segments.pop();
        try { await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.conflictsRoot(), ...segments)); } catch { /* noop */ }
    }

    private async writeBaseSnapshot(relPath: string, bytes: Uint8Array): Promise<void> {
        if (!this.shouldSnapshot(relPath)) return;                  // ⛔ ignored → no snapshot
        await this.ensureBaseStore();
        await vscode.workspace.fs.createDirectory(this.baseSnapDirUri(relPath)); // mkdir -p
        await vscode.workspace.fs.writeFile(this.baseSnapUri(relPath), bytes);
    }

    private async readBaseSnapshot(relPath: string): Promise<Uint8Array | undefined> {
        if (!this.shouldSnapshot(relPath)) return undefined;        // ⛔ ignored → pretend none
        try {
            return await vscode.workspace.fs.readFile(this.baseSnapUri(relPath));
        } catch {
            return undefined;
        }
    }

    private async deleteBaseSnapshot(relPath: string): Promise<void> {
        if (!this.shouldSnapshot(relPath)) return;                  // ⛔ ignored → nothing to delete
        try { await vscode.workspace.fs.delete(this.baseSnapUri(relPath)); } catch { /* noop */ }
    }

    /** Load snapshots from disk into memory (skip ignored files). */
    private async loadAllBaseSnapshots(): Promise<void> {
        const root = this.baseStoreRoot();
        try { await vscode.workspace.fs.stat(root); } catch { return; } // no store yet

        const q: Array<{ uri: vscode.Uri, prefix: string }> = [{ uri: root, prefix: '/' }];
        while (q.length) {
            const { uri, prefix } = q.shift()!;
            const entries = await vscode.workspace.fs.readDirectory(uri);
            for (const [name, type] of entries) {
                const child = vscode.Uri.joinPath(uri, name);
                if (type === vscode.FileType.Directory) {
                    q.push({ uri: child, prefix: prefix + name + '/' });
                } else if (type === vscode.FileType.File) {
                    const relPath = prefix + name; // leading '/'
                    if (this.shouldSnapshot(relPath)) {
                        try {
                            const bytes = await vscode.workspace.fs.readFile(child);
                            // ✅ load whatever is there (text or binary)
                            this.baseCache[relPath] = bytes;
                        } catch { /* ignore unreadable */ }
                    }
                }
            }
        }
    }

    // --------------------------- Binary reconcile -------------------------------
    private bytesEq(a?: Uint8Array, b?: Uint8Array): boolean {
        if (!a || !b) return false;
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
        return true;
    }

    /** Write an artifact copy into .overleaf/conflicts to preserve the losing side. */
    private async writeConflictArtifact(relPath: string, suffix: 'LOCAL' | 'REMOTE' | 'BASE', bytes?: Uint8Array) {
        if (!bytes) return;
        await this.ensureConflictsStore(relPath);
        const uri = this.conflictArtifactUri(relPath, suffix);
        await vscode.workspace.fs.writeFile(uri, bytes);
    }

    /** Binary reconcile path: deterministic and editor-less. */
    private async reconcileBinary(relPath: string, vfsUri: vscode.Uri, baseBytes?: Uint8Array, localBytes?: Uint8Array, remoteBytes?: Uint8Array): Promise<'noop' | 'merged'> {
        // Nothing anywhere → clean state
        if (!localBytes && !remoteBytes) {
            delete this.baseCache[relPath];
            await this.deleteBaseSnapshot(relPath);
            return 'noop';
        }

        // If only one side exists → copy it to the other and advance BASE
        if (localBytes && !remoteBytes) {
            // push local to remote
            this.setBypassCache(relPath, localBytes);
            await vscode.workspace.fs.writeFile(vfsUri, localBytes);
            this.baseCache[relPath] = localBytes;
            await this.writeBaseSnapshot(relPath, localBytes);
            return 'merged';
        }
        if (!localBytes && remoteBytes) {
            // pull remote to local
            this.setBypassCache(relPath, remoteBytes);
            await this.writeFile(relPath, remoteBytes);
            this.baseCache[relPath] = remoteBytes;
            await this.writeBaseSnapshot(relPath, remoteBytes);
            return 'merged';
        }

        // Both exist
        const local = localBytes!;
        const remote = remoteBytes!;
        const base = baseBytes;

        // Any two equal → take that side
        if (this.bytesEq(local, remote)) {
            this.baseCache[relPath] = local;
            await this.writeBaseSnapshot(relPath, local);
            return 'noop';
        }
        if (base && this.bytesEq(local, base) && !this.bytesEq(remote, base)) {
            // Local unchanged vs BASE → take remote
            this.setBypassCache(relPath, remote);
            await this.writeFile(relPath, remote);
            this.setBypassCache(relPath, remote);
            await vscode.workspace.fs.writeFile(vfsUri, remote);
            this.baseCache[relPath] = remote;
            await this.writeBaseSnapshot(relPath, remote);
            return 'merged';
        }
        if (base && this.bytesEq(remote, base) && !this.bytesEq(local, base)) {
            // Remote unchanged vs BASE → take local
            this.setBypassCache(relPath, local);
            await vscode.workspace.fs.writeFile(vfsUri, local);
            this.setBypassCache(relPath, local);
            await this.writeFile(relPath, local);
            this.baseCache[relPath] = local;
            await this.writeBaseSnapshot(relPath, local);
            return 'merged';
        }

        // True conflict (all different). Choose a winner; save loser as artifact.
        const winner: 'REMOTE' | 'LOCAL' = (BINARY_CONFLICT_STRATEGY === 'prefer-remote') ? 'REMOTE' : 'LOCAL';
        const result = winner === 'REMOTE' ? remote : local;
        const loserBytes = winner === 'REMOTE' ? local : remote;
        const loserTag: 'LOCAL' | 'REMOTE' = winner === 'REMOTE' ? 'LOCAL' : 'REMOTE';

        await this.writeConflictArtifact(relPath, loserTag, loserBytes);
        if (base) await this.writeConflictArtifact(relPath, 'BASE', base);

        // Write winner to both sides and advance BASE
        this.setBypassCache(relPath, result);
        await this.writeFile(relPath, result);
        this.setBypassCache(relPath, result);
        await vscode.workspace.fs.writeFile(vfsUri, result);

        this.baseCache[relPath] = result;
        await this.writeBaseSnapshot(relPath, result);

        // Optional: surface a one-time notification
        vscode.window.showWarningMessage(
            vscode.l10n.t(`Binary conflict on {0}: kept {1}, saved other copy to .overleaf/conflicts`, relPath, winner)
        );

        return 'merged';
    }

    // --------------------------- Text reconcile (unchanged) ----------------------

    /** Merge-first reconcile used on reconnect/updates.
     *  Produces a single RESULT, writes only when content differs, and advances BASE.
     *  For binaries: routes to reconcileBinary (no skipping).
     */
    private async reconcileOnReconnect(
        relPath: string,
        vfsUri: vscode.Uri,
        _origin: 'pull' | 'push' | 'bulk' = 'bulk'
    ): Promise<'noop' | 'merged'> {
        if (this.matchIgnorePatterns(relPath)) return 'noop';

        const td = new TextDecoder();
        const te = new TextEncoder();

        // Read current states (remote may not exist)
        const baseBytes = this.baseCache[relPath] ?? await this.readBaseSnapshot(relPath); // lazy load if needed
        if (baseBytes && !this.baseCache[relPath]) this.baseCache[relPath] = baseBytes;

        const localBytes = await this.readFile(relPath);      // may be undefined
        let remoteBytes: Uint8Array | undefined;
        try { remoteBytes = await vscode.workspace.fs.readFile(vfsUri); }
        catch { remoteBytes = undefined; }

        // ── If any side looks binary, handle with the binary reconcilor ──────────
        if (isProbablyBinary(baseBytes) || isProbablyBinary(localBytes) || isProbablyBinary(remoteBytes)) {
            return await this.reconcileBinary(relPath, vfsUri, baseBytes, localBytes, remoteBytes);
        }

        // Nothing anywhere
        if (!localBytes && !remoteBytes) {
            delete this.baseCache[relPath];
            await this.deleteBaseSnapshot(relPath);
            return 'noop';
        }

        // Decide RESULT text
        let resultText: string | undefined;

        // ── No BASE known: never pick a side silently ─────────────────────────────
        if (!baseBytes) {
            if (localBytes && remoteBytes) {
                if (this.bytesEq(localBytes, remoteBytes)) {
                    this.baseCache[relPath] = remoteBytes;
                    await this.writeBaseSnapshot(relPath, remoteBytes);
                    return 'noop';
                }
                // Divergent without ancestor → force interactive editor
                resultText = await merge.openMergeEditorSmart({
                    title: `Reconciling ${relPath}`,
                    base: td.decode(remoteBytes),   // seed; user resolves
                    local: td.decode(localBytes),
                    remote: td.decode(remoteBytes),
                });
            } else if (localBytes && !remoteBytes) {
                resultText = td.decode(localBytes);
            } else if (!localBytes && remoteBytes) {
                resultText = td.decode(remoteBytes);
            }
        }

        // ── BASE present: true 3-way (editor on conflict) ─────────────────────────
        if (baseBytes && resultText === undefined) {
            const base = td.decode(baseBytes);
            const local = td.decode(localBytes ?? baseBytes);
            const remote = td.decode(remoteBytes ?? baseBytes);

            // Auto-merge; editor opens if conflicts
            resultText = await merge.resolveWithEditorIfNeeded({
                title: `Merging ${relPath}`,
                base, local, remote,
            });
        }

        if (resultText === undefined) return 'noop';
        const resultBytes = te.encode(resultText);

        // Only write when content actually changes (prevents echo churn)
        const needWriteLocal = !localBytes || !this.bytesEq(localBytes, resultBytes);
        const needWriteRemote = !remoteBytes || !this.bytesEq(remoteBytes, resultBytes);

        if (!needWriteLocal && !needWriteRemote) {
            // Both already at RESULT; advance BASE
            this.baseCache[relPath] = resultBytes;
            await this.writeBaseSnapshot(relPath, resultBytes);
            return 'noop';
        }

        // Local write (stamp symmetric bypass so local->VFS watcher ignores echo)
        if (needWriteLocal) {
            this.setBypassCache(relPath, resultBytes);
            await this.writeFile(relPath, resultBytes);
        }

        // Remote write (stamp symmetric bypass so VFS->local watcher ignores echo)
        if (needWriteRemote) {
            this.setBypassCache(relPath, resultBytes);
            await vscode.workspace.fs.writeFile(vfsUri, resultBytes);
        }

        // Advance BASE once to RESULT (and persist)
        this.baseCache[relPath] = resultBytes;
        await this.writeBaseSnapshot(relPath, resultBytes);

        return 'merged';
    }

    private async reconcileAll(root = '/'): Promise<void> {
        if (this.bulkInFlight) return this.bulkInFlight;
        this.bulkInFlight = (async () => {
            this.syncSuspended = true;
            try {
                const files: string[] = [];
                const queue = [root];
                while (queue.length) {
                    const next = queue.shift()!;
                    const dirUri = this.vfs.pathToUri(next);
                    const entries = await vscode.workspace.fs.readDirectory(dirUri);
                    for (const [name, type] of entries) {
                        const rel = next + name;
                        if (this.matchIgnorePatterns(rel)) continue;
                        if (type === vscode.FileType.Directory) queue.push(rel + '/');
                        else files.push(rel);
                    }
                }
                for (const relPath of files) {
                    const vfsUri = this.vfs.pathToUri(relPath);
                    try { await this.reconcileOnReconnect(relPath, vfsUri, 'bulk'); } catch { }
                }
            } finally {
                this.syncSuspended = false;
            }
        })();
        try { await this.bulkInFlight; } finally { this.bulkInFlight = undefined; }
    }

    public async reconcileNow() {
        console.log("reconcileNow")
        await this.reconcileAll("/");
    }

    private async syncFromVFS(vfsUri: vscode.Uri, type: 'update' | 'delete') {
        if (this.syncSuspended) return;
        const { pathParts } = parseUri(vfsUri);
        if (pathParts.at(-1) === '') pathParts.pop();
        const relPath = '/' + pathParts.join('/');
        const localUri = vscode.Uri.joinPath(this.baseUri, relPath);
        await this.applySync('pull', type, relPath, vfsUri, localUri);
    }

    private async syncToVFS(localUri: vscode.Uri, type: 'update' | 'delete') {
        if (this.syncSuspended) return;
        const basePath = this.baseUri.path;
        const relPath = localUri.path.slice(basePath.length);
        const vfsUri = this.vfs.pathToUri(relPath);
        if (!vfsUri) return;
        await this.applySync('push', type, relPath, localUri, vfsUri);
    }

    private async ensureSettingsJson(): Promise<void> {
        // .overleaf/settings.json
        const overleafDir = vscode.Uri.joinPath(this.baseUri, '.overleaf');
        const settingUri = vscode.Uri.joinPath(overleafDir, 'settings.json');

        // If it already exists, we're done
        try { await vscode.workspace.fs.stat(settingUri); return; } catch { }

        // Ensure the directory exists
        try { await vscode.workspace.fs.createDirectory(overleafDir); } catch { }

        // Prepare contents
        const settings = {
            uri: this.vfs.origin.toString(),
            serverName: this.vfs.serverName,
            enableCompileNPreview: false,
            projectName: this.vfs.projectName,
        };

        // Write as Uint8Array (NOT Buffer)
        const bytes = new TextEncoder().encode(JSON.stringify(settings, null, 4));
        await vscode.workspace.fs.writeFile(settingUri, bytes);
    }

    private async initWatch() {
        // write ".overleaf/settings.json" if it does not exist
        await this.ensureSettingsJson();

        this.vfsWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.vfs.origin, '**/*')
        );
        this.localWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.baseUri.path, '**/*')
        );

        // Initial merge-first reconcile (no overwrite)
        await this.ensureBaseStore();
        await this.loadAllBaseSnapshots();
        // await this.reconcileAll('/');

        const disposables: vscode.Disposable[] = [
            this.vfsWatcher.onDidChange(async uri => { if (!this.syncSuspended) await this.syncFromVFS(uri, 'update'); }),
            this.vfsWatcher.onDidCreate(async uri => { if (!this.syncSuspended) await this.syncFromVFS(uri, 'update'); }),
            this.vfsWatcher.onDidDelete(async uri => { if (!this.syncSuspended) await this.syncFromVFS(uri, 'delete'); }),
            this.localWatcher.onDidChange(async uri => { if (!this.syncSuspended) await this.syncToVFS(uri, 'update'); }),
            this.localWatcher.onDidCreate(async uri => { if (!this.syncSuspended) await this.syncToVFS(uri, 'update'); }),
            this.localWatcher.onDidDelete(async uri => { if (!this.syncSuspended) await this.syncToVFS(uri, 'delete'); }),
        ];

        // Subscribe via VFS' bridged events (which hook the socket exactly once)
        const lifecycle = this.vfs.onSocketLifecycle({
            onDisconnected: async () => {
                this.wasOffline = true;
                this.syncSuspended = true;          // 🚫 freeze immediately
                if (await isReplica()) this.handleReplicaDisconnect();           // 🔔 modal + sticky (only once)
            },
            onReconnected: async () => {
                if (!this.wasOffline) return;       // ignore cold start connects
                this.wasOffline = false;
                if (await isReplica()) this.handleReplicaReconnect();           // 🔔 modal + sticky (only once)
            },
        });

        disposables.push(lifecycle);

        return [...disposables, this.vfsWatcher!, this.localWatcher!];
    }

    // ---- on disconnect: modal first, then sticky notice ----
    private async handleReplicaDisconnect() {
        console.log("[LocalReplicaSCM] disconnected");
        console.count('[SCM] onDisconnected');
        if (this.offlineModalShown) return;       // only once per outage
        this.offlineModalShown = true;
        this.wasOffline = true;

        const title = vscode.l10n.t('You have lost connection to the server.');
        const detail = vscode.l10n.t("Since you're in a local replica, it is safe to continue editing. You'll be prompted to reconcile your changes upon reconnecting.");

        // 1) Modal — user must dismiss to resume editing
        await vscode.window.showWarningMessage(title, { modal: true, detail }, vscode.l10n.t('OK'));

        // 2) Sticky, non-error notification that persists while offline
        if (!this.resolveOfflineNotice) {
            let resolve!: () => void;
            const gate = new Promise<void>(r => (resolve = r));
            this.resolveOfflineNotice = resolve;

            void vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title },
                async (progress) => {
                    progress.report({ message: detail });
                    await gate; // stays visible until we resolve it on reconnect
                }
            );
        }
    }

    private async handleReplicaReconnect() {
        console.log("[LocalReplicaSCM] reconnected");
        console.count('[SCM] onReconnected');
        // ✅ Close the sticky and reset one-shot flag
        if (this.resolveOfflineNotice) {
            try { this.resolveOfflineNotice(); } catch { }
            this.resolveOfflineNotice = undefined;
        }
        this.offlineModalShown = false;

        // Offer reconcile; remain suspended until user accepts
        const choice = await vscode.window.showInformationMessage(
            vscode.l10n.t('Connection restored. Reconcile Local Replica with server now?'),
            vscode.l10n.t('Reconcile now'),
            vscode.l10n.t('Dismiss')
        );

        if (choice === vscode.l10n.t('Reconcile now')) {
            // Bulk reconcile: pulls remote, compares to base, 3-way merge editor if needed
            await this.reconcileAll('/');
            this.syncSuspended = false;       // ✅ resume normal syncing after successful reconcile
        } else {
            // User dismissed — keep sync suspended to avoid silent overwrites.
        }
    }

    writeFile(relPath: string, content: Uint8Array): Thenable<void> {
        const uri = vscode.Uri.joinPath(this.baseUri, relPath);
        return vscode.workspace.fs.writeFile(uri, content);
    }

    readFile(relPath: string): Thenable<Uint8Array | undefined> {
        const uri = vscode.Uri.joinPath(this.baseUri, relPath);
        return new Promise(async (resolve, reject) => {
            try {
                const content = await vscode.workspace.fs.readFile(uri);
                resolve(content);
            } catch (error) {
                resolve(undefined);
            }
        });
    }

    get triggers(): Promise<vscode.Disposable[]> {
        return this.initWatch().then((watches) => {
            // <- this disposable clears the active replica when triggers are disposed
            const clearActive = new vscode.Disposable(() => {
                if (ActiveReplica.get() === this) ActiveReplica.set(undefined);
            });

            const out: vscode.Disposable[] = [clearActive];

            if (this.vfsWatcher) out.push(this.vfsWatcher);
            if (this.localWatcher) out.push(this.localWatcher);

            return [...out, ...watches];
        });
    }

    public static get baseUriInputBox(): vscode.QuickPick<vscode.QuickPickItem> {
        const sep = require('path').sep;
        const inputBox = vscode.window.createQuickPick();
        inputBox.placeholder = vscode.l10n.t('e.g., /home/user/empty/local/folder');
        inputBox.value = require('os').homedir() + sep;
        // enable auto-complete
        inputBox.onDidChangeValue(async value => {
            try {
                // remove the last part of the path
                inputBox.busy = true;
                const path = value.split(sep).slice(0, -1).join(sep);
                const items = await vscode.workspace.fs.readDirectory(vscode.Uri.file(path));
                const subDirs = items.filter(([name, type]) => type === vscode.FileType.Directory)
                    .filter(([name, type]) => `${path}${sep}${name}`.startsWith(value));
                inputBox.busy = false;
                // update the sub-directories
                if (subDirs.length !== 0) {
                    const candidates = subDirs.map(([name, type]) => ({ label: name, alwaysShow: true, picked: false }));
                    if (path !== '') {
                        candidates.unshift({ label: '..', alwaysShow: true, picked: false });
                    }
                    inputBox.items = candidates;
                }
            }
            finally {
                inputBox.activeItems = [];
            }
        });
        inputBox.onDidAccept(() => {
            if (inputBox.activeItems.length !== 0) {
                const selected = inputBox.selectedItems[0];
                const path = inputBox.value.split(sep).slice(0, -1).join(sep);
                inputBox.value = selected.label === '..' ? path : `${path}${sep}${selected.label}${sep}`;
            }
        });
        return inputBox;
    }

    get settingItems(): SettingItem[] {
        return [
            // configure ignore patterns
            {
                label: vscode.l10n.t('Configure sync ignore patterns ...'),
                callback: async () => {
                    const ignorePatterns = (this.getSetting<string[]>(IGNORE_SETTING_KEY) || this.ignorePatterns).sort();
                    const quickPick = vscode.window.createQuickPick();
                    quickPick.ignoreFocusOut = true;
                    quickPick.title = vscode.l10n.t('Press Enter to add a new pattern, or click the trash icon to remove a pattern.');
                    quickPick.items = ignorePatterns.map(pattern => ({
                        label: pattern,
                        buttons: [{ iconPath: new vscode.ThemeIcon('trash') }],
                    }));
                    // remove pattern when click the trash icon
                    quickPick.onDidTriggerItemButton(async ({ item }) => {
                        const index = ignorePatterns.indexOf(item.label);
                        ignorePatterns.splice(index, 1);
                        await this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                        quickPick.items = ignorePatterns.map(pattern => ({
                            label: pattern,
                            buttons: [{ iconPath: new vscode.ThemeIcon('trash') }],
                        }));
                    });
                    // add new pattern when not exist
                    quickPick.onDidAccept(async () => {
                        if (quickPick.selectedItems.length === 0) {
                            const pattern = quickPick.value;
                            if (pattern !== '') {
                                ignorePatterns.push(pattern);
                                await this.setSetting(IGNORE_SETTING_KEY, ignorePatterns);
                                quickPick.items = ignorePatterns.map(pattern => ({
                                    label: pattern,
                                    buttons: [{ iconPath: new vscode.ThemeIcon('trash') }],
                                }));
                                quickPick.value = '';
                            }
                        }
                    });
                    // show the quick pick
                    quickPick.show();
                },
            },
        ];
    }

    list(): Iterable<CommitItem> { return []; }
    async apply(commitItem: CommitItem): Promise<void> { return Promise.resolve(); }
    syncFromSCM(commits: Iterable<CommitItem>): Promise<void> { return Promise.resolve(); }
}
