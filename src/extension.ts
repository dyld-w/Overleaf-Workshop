import * as vscode from "vscode";
import { ROOT_NAME } from "./consts";

import {
    RemoteFileSystemProvider,
    VirtualFileSystem,
} from "./core/remoteFileSystemProvider";
import { ProjectManagerProvider } from "./core/projectManagerProvider";
import { PdfViewEditorProvider } from "./core/pdfViewEditorProvider";
import { CompileManager } from "./compile/compileManager";
import { LangIntellisenseProvider } from "./intellisense";
import { LocalReplicaSCMProvider } from "./scm/localReplicaSCM";
import { ActiveReplica } from "./utils/activeReplica";

export function activate(context: vscode.ExtensionContext) {
    // Register: [core] RemoteFileSystemProvider
    const remoteFileSystemProvider = new RemoteFileSystemProvider(context);
    context.subscriptions.push(...remoteFileSystemProvider.triggers);

    // Register: [core] ProjectManagerProvider
    const projectManagerProvider = new ProjectManagerProvider(context);
    context.subscriptions.push(...projectManagerProvider.triggers);

    // Register: [core] PdfViewEditorProvider
    const pdfViewEditorProvider = new PdfViewEditorProvider(context);
    context.subscriptions.push(...pdfViewEditorProvider.triggers);

    // Register: [compile] CompileManager
    const compileManager = new CompileManager(remoteFileSystemProvider);
    context.subscriptions.push(...compileManager.triggers);

    // Register: [intellisense]
    const langIntellisenseProvider = new LangIntellisenseProvider(
        context,
        remoteFileSystemProvider
    );
    context.subscriptions.push(...langIntellisenseProvider.triggers);

    // Activate VFS for local replica
    LocalReplicaSCMProvider.readSettings().then(async (setting) => {
        if (setting?.uri) {
            const uri = vscode.Uri.parse(setting.uri);
            if (uri.scheme === ROOT_NAME) {
                // activate vfs
                const vfs = (await await vscode.commands.executeCommand(
                    "remoteFileSystem.prefetch",
                    uri
                )) as VirtualFileSystem;
                await vfs.init();

                // contexts your UI relies on
                vscode.commands.executeCommand(
                    "setContext",
                    `${ROOT_NAME}.activate`,
                    true
                );

                // Register: local replica reconcileNow command
                context.subscriptions.push(
                    vscode.commands.registerCommand("overleaf-workshop.reconcileNow", async () => {
                        const rep = ActiveReplica.get();
                        if (!rep) {
                            vscode.window.showInformationMessage(
                                vscode.l10n.t("No Overleaf project is open to reconcile.")
                            );
                            return;
                        }
                        try {
                            await rep.reconcileNow();
                        } catch (e) {
                            vscode.window.showErrorMessage(
                                vscode.l10n.t("Reconcile failed: {0}", String(e))
                            );
                        }
                    })
                );

                if (setting?.enableCompileNPreview) {
                    vscode.commands.executeCommand(
                        "setContext",
                        `${ROOT_NAME}.activateCompile`,
                        true
                    );
                }
            }
        }
    });
}

export function deactivate() {
    ActiveReplica.set(undefined);
    vscode.commands.executeCommand("setContext", `${ROOT_NAME}.activate`, false);
    vscode.commands.executeCommand(
        "setContext",
        `${ROOT_NAME}.activateCompile`,
        false
    );
}
