import * as vscode from 'vscode';

/** Guard for one-shot self-initiated writes (keyed by full URI). */
const bypass = new Set<string>();

export function isBypassed(uri: vscode.Uri): boolean {
  return bypass.has(uri.toString());
}

export function markBypass(uri: vscode.Uri): void {
  bypass.add(uri.toString());
}

export function clearBypass(uri: vscode.Uri): void {
  bypass.delete(uri.toString());
}

/** Convenience for try/finally patterns. */
export function markBypassOnce(uri: vscode.Uri): () => void {
  markBypass(uri);
  return () => clearBypass(uri);
}
