import * as vscode from 'vscode';
import { minimatch } from 'minimatch';
import { BaseSCM, CommitItem, SettingItem } from ".";
import { VirtualFileSystem, parseUri } from '../core/remoteFileSystemProvider';
import * as merge from '../merge';

const IGNORE_SETTING_KEY = 'ignore-patterns';

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
    ];

    constructor(
        protected readonly vfs: VirtualFileSystem,
        public readonly baseUri: vscode.Uri,
    ) {
        super(vfs, baseUri);
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
                if (action === 'push' && now - cache[0].date < 500 || action === 'pull' && now - cache[1].date < 500) {
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
    private relSegments(relPath: string): string[] {
        const rel = relPath.startsWith('/') ? relPath.slice(1) : relPath;
        return rel ? rel.split('/') : [];
    }
    private baseSnapUri(relPath: string): vscode.Uri {
        const segs = this.relSegments(relPath);
        return vscode.Uri.joinPath(this.baseStoreRoot(), ...segs);
    }
    private baseSnapDirUri(relPath: string): vscode.Uri {
        const segs = this.relSegments(relPath);
        segs.pop(); // parent only
        return vscode.Uri.joinPath(this.baseStoreRoot(), ...segs);
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
                    if (this.shouldSnapshot(relPath)) {              // ✅ only load non-ignored
                        try {
                            const bytes = await vscode.workspace.fs.readFile(child);
                            this.baseCache[relPath] = bytes;
                        } catch { /* ignore unreadable */ }
                    }
                }
            }
        }
    }

    // 1) Add a couple of fields to coordinate reconnect reconciles
    private syncSuspended = false;              // gate watchers during bulk reconcile
    private wasOffline = false;                 // track offline→online transitions
    private bulkInFlight?: Promise<void>;       // debounce concurrent runs

    /** Merge-first reconcile used on reconnect/updates.
     *  Produces a single RESULT, writes only when content differs, and advances BASE.
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

        const bytesEq = (a?: Uint8Array, b?: Uint8Array) =>
            !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
        const looksBinary = (s: string) => /\x00/.test(s);

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
                if (bytesEq(localBytes, remoteBytes)) {
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

            if (looksBinary(base) || looksBinary(local) || looksBinary(remote)) {
                if (!bytesEq(localBytes, remoteBytes)) {
                    const choice = await vscode.window.showWarningMessage(
                        `${relPath} appears binary and differs. Choose:`,
                        { modal: true },
                        'Keep local (push)', 'Accept remote (pull)'
                    );
                    resultText = (choice === 'Keep local (push)') ? td.decode(localBytes!) : td.decode(remoteBytes!);
                } else {
                    // equal → nothing to do
                    return 'noop';
                }
            } else {
                // Auto-merge; editor opens if conflicts
                resultText = await merge.resolveWithEditorIfNeeded({
                    title: `Merging ${relPath}`,
                    base, local, remote,
                });
            }
        }

        if (resultText === undefined) return 'noop';
        const resultBytes = te.encode(resultText);

        // Only write when content actually changes (prevents echo churn)
        const needWriteLocal = !localBytes || !bytesEq(localBytes, resultBytes);
        const needWriteRemote = !remoteBytes || !bytesEq(remoteBytes, resultBytes);

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

    // 3) Gate watchers so they don’t echo during bulk reconciles
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

    private async initWatch() {
        // write ".overleaf/settings.json" if it does not exist
        const overleafDir = vscode.Uri.joinPath(this.baseUri, '.overleaf');
        const settingUri = vscode.Uri.joinPath(overleafDir, 'settings.json');

        this.vfsWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.vfs.origin, '**/*')
        );
        this.localWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(this.baseUri.path, '**/*')
        );

        // Initial merge-first reconcile (no overwrite)
        await this.ensureBaseStore();
        await this.loadAllBaseSnapshots();
        await this.reconcileAll('/');

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
            onDisconnected: () => { this.wasOffline = true; },
            onReconnected: async () => {
                if (!this.wasOffline) return;
                this.wasOffline = false;
                await this.reconcileAll('/');
            },
        });

        return [...disposables, lifecycle, this.vfsWatcher!, this.localWatcher!];
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
            if (this.vfsWatcher !== undefined && this.localWatcher !== undefined) {
                return [
                    this.vfsWatcher,
                    this.localWatcher,
                    ...watches,
                ];
            } else {
                return [];
            }
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
