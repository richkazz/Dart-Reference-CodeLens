"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DartCodeLensProvider = void 0;
const vscode = require("vscode");
class DartCodeLens extends vscode.CodeLens {
    constructor(documentUri, range, symbolKind, symbolId // Used for cache key
    ) {
        super(range);
        this.documentUri = documentUri;
        this.symbolKind = symbolKind;
        this.symbolId = symbolId;
    }
}
class DartCodeLensProvider {
    constructor() {
        this._onDidChangeCodeLenses = new vscode.EventEmitter();
        this.onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
        this.cache = new Map();
        // Debounce configuration changes
        vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('dartReferenceCodeLens')) {
                this.triggerRefresh();
            }
        });
        // Clear cache when document closes to prevent leaks
        vscode.workspace.onDidCloseTextDocument(doc => {
            this.clearCacheForDocument(doc.uri);
        });
    }
    triggerRefresh() {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        this.refreshTimer = setTimeout(() => {
            this._onDidChangeCodeLenses.fire();
            this.refreshTimer = undefined;
        }, 500); // 500ms debounce
    }
    refresh() {
        this.cache.clear();
        this._onDidChangeCodeLenses.fire();
    }
    clearCacheForDocument(uri) {
        const prefix = uri.toString();
        // Since Map keys are strings, we iterate. 
        // For very large workspaces this might be slow, but usually open docs are few.
        // A better structure might be Map<UriString, Map<SymbolId, CacheEntry>>.
        // Let's optimize slightly by just keeping it simple for now or switching structure if needed.
        // Actually, Map deletion while iterating is safe.
        for (const key of this.cache.keys()) {
            if (key.startsWith(prefix)) {
                this.cache.delete(key);
            }
        }
    }
    async provideCodeLenses(document, token) {
        const config = vscode.workspace.getConfiguration('dartReferenceCodeLens');
        if (!config.get('enabled')) {
            return [];
        }
        const excludePatterns = config.get('excludePatterns') || [];
        for (const pattern of excludePatterns) {
            if (vscode.languages.match({ pattern: pattern, scheme: 'file' }, document)) {
                return [];
            }
        }
        const lenses = [];
        try {
            const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri);
            if (!symbols || symbols.length === 0) {
                return [];
            }
            this.processSymbols(document, symbols, lenses, config);
        }
        catch (e) {
            console.error('Error providing code lenses:', e);
        }
        return lenses;
    }
    processSymbols(document, symbols, lenses, config) {
        const showClasses = config.get('showClasses');
        const showMethods = config.get('showMethods');
        const showProperties = config.get('showProperties');
        const showConstructors = config.get('showConstructors');
        const showEnums = config.get('showEnums'); // Enums handled as Class usually or Enum if supported
        const showVariables = config.get('showVariables');
        const ignoredMethodNames = config.get('ignoredMethodNames') || [];
        for (const symbol of symbols) {
            let shouldShow = false;
            if (symbol.kind === vscode.SymbolKind.Class && showClasses) {
                shouldShow = true;
            }
            else if ((symbol.kind === vscode.SymbolKind.Method || symbol.kind === vscode.SymbolKind.Function) && showMethods) {
                shouldShow = true;
            }
            else if (symbol.kind === vscode.SymbolKind.Property && showProperties) {
                shouldShow = true;
            }
            else if (symbol.kind === vscode.SymbolKind.Constructor && showConstructors) {
                shouldShow = true;
            }
            else if (symbol.kind === vscode.SymbolKind.Enum && showEnums) {
                shouldShow = true;
            }
            else if (symbol.kind === vscode.SymbolKind.Variable && showVariables) {
                shouldShow = true;
            }
            if (symbol.name.startsWith('_')) {
                shouldShow = false;
            }
            // Check if method/function name is in the ignored list
            // Extract the base method name (before any parentheses for methods with signatures)
            if (symbol.kind === vscode.SymbolKind.Method || symbol.kind === vscode.SymbolKind.Function) {
                const baseName = symbol.name.split('(')[0].trim();
                if (ignoredMethodNames.includes(baseName)) {
                    shouldShow = false;
                }
            }
            if (shouldShow) {
                // Generate a unique ID for cache key: Uri + Range
                // This is stable enough for the same document version.
                const id = `${document.uri.toString()}::${symbol.range.start.line}:${symbol.range.start.character}`;
                const lens = new DartCodeLens(document.uri, symbol.selectionRange, symbol.kind, id);
                lenses.push(lens);
            }
            if (symbol.children && symbol.children.length > 0) {
                this.processSymbols(document, symbol.children, lenses, config);
            }
        }
    }
    async resolveCodeLens(codeLens, token) {
        const config = vscode.workspace.getConfiguration('dartReferenceCodeLens');
        const highlightUnused = config.get('highlightUnused');
        const minReferences = config.get('minReferencesToShow') || 0;
        // Check cache
        // We need to know the document version to validate cache
        // However, resolveCodeLens doesn't give us the document implementation directly, only URI.
        // We can try to look it up or use the URI. 
        // Ideally, we passed the version in data or we look up open text documents.
        // For simplicity, we'll try to find the document.
        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === codeLens.documentUri.toString());
        const version = doc ? doc.version : 0;
        const cacheKey = codeLens.symbolId;
        let refCount;
        if (this.cache.has(cacheKey)) {
            const entry = this.cache.get(cacheKey);
            if (entry.version === version) {
                refCount = entry.count;
            }
        }
        if (refCount === undefined) {
            try {
                const locations = await vscode.commands.executeCommand('vscode.executeReferenceProvider', codeLens.documentUri, codeLens.range.start);
                refCount = 0;
                if (locations) {
                    for (const loc of locations) {
                        if (loc.uri.toString() === codeLens.documentUri.toString() &&
                            codeLens.range.intersection(loc.range)) {
                            continue;
                        }
                        refCount++;
                    }
                }
                // Update cache
                this.cache.set(cacheKey, { version: version, count: refCount });
            }
            catch (e) {
                console.error(e);
                codeLens.command = {
                    title: 'Error',
                    command: ''
                };
                return codeLens;
            }
        }
        if (refCount < minReferences) {
            // "Hide" it by showing nothing or a very subtle indicator. 
            // We can't actually hide the lens line height.
            // Let's show a dimmed "0 refs" or similar if the user *really* requested a min.
            // Or we just don't return a command title, which might leave it blank?
            // Usually returning the codeLens as is (without command) won't render text.
            // Let's try returning it without command.
            return codeLens;
        }
        let title = '';
        if (refCount === 1) {
            title = '1 reference';
        }
        else {
            title = `${refCount} references`;
        }
        if (refCount === 0 && highlightUnused) {
            title = `⚠️ ${title}`;
        }
        codeLens.command = {
            title: title,
            tooltip: 'Click to show references',
            command: 'dartReferenceCodeLens.showReferences',
            arguments: [
                codeLens.documentUri,
                codeLens.range.start
            ]
        };
        return codeLens;
    }
}
exports.DartCodeLensProvider = DartCodeLensProvider;
//# sourceMappingURL=codelensProvider.js.map