"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.deactivate = exports.activate = void 0;
const vscode = require("vscode");
const codelensProvider_1 = require("./codelensProvider");
function activate(context) {
    console.log('Dart Reference CodeLens is now active');
    const provider = new codelensProvider_1.DartCodeLensProvider();
    // Register the CodeLens provider for Dart files
    const selector = { language: 'dart', scheme: 'file' };
    const providerRegistration = vscode.languages.registerCodeLensProvider(selector, provider);
    context.subscriptions.push(providerRegistration);
    // Register commands
    context.subscriptions.push(vscode.commands.registerCommand('dartReferenceCodeLens.refresh', () => {
        // Re-registering effectively refreshes, or we can just trigger a document change event if we had one.
        // But for CodeLens, usually provider firing onDidChangeCodeLenses is better.
        provider.refresh();
    }), vscode.commands.registerCommand('dartReferenceCodeLens.toggle', () => {
        const config = vscode.workspace.getConfiguration('dartReferenceCodeLens');
        const current = config.get('enabled');
        config.update('enabled', !current, true);
    }), vscode.commands.registerCommand('dartReferenceCodeLens.showReferences', async (uri, position) => {
        await vscode.commands.executeCommand('editor.action.peekLocations', uri, position, []);
        // Alternatively, we could run 'editor.action.referenceSearch.trigger' if we set the selection first
        // But peekLocations with empty array might just show nothing or "loading"? 
        // Actually 'editor.action.showReferences' is the standard one, but it requires the array of locations.
        // Since we don't have the array (we cached the count), we need to re-fetch or force the UI to fetch.
        // The cleanest way in VS Code extension API to "Show References" without already having them is 
        // to execute "vscode.executeReferenceProvider" again and then show, OR
        // just trigger the UI command that does it.
        // "editor.action.referenceSearch.trigger" works on the current selection.
        const editor = await vscode.window.showTextDocument(uri);
        editor.selection = new vscode.Selection(position, position);
        await vscode.commands.executeCommand('editor.action.referenceSearch.trigger');
    }));
}
exports.activate = activate;
function deactivate() { }
exports.deactivate = deactivate;
//# sourceMappingURL=extension.js.map