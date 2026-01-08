import * as vscode from 'vscode';


// Simple cache entry
interface CacheEntry {
    version: number;
    count: number;
}

class DartCodeLens extends vscode.CodeLens {
    constructor(
        public readonly documentUri: vscode.Uri,
        range: vscode.Range,
        public readonly symbolKind: vscode.SymbolKind,
        public readonly symbolId: string // Used for cache key
    ) {
        super(range);
    }
}

export class DartCodeLensProvider implements vscode.CodeLensProvider {
    private _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
    public readonly onDidChangeCodeLenses: vscode.Event<void> = this._onDidChangeCodeLenses.event;
    
    private refreshTimer: NodeJS.Timeout | undefined;
    private cache: Map<string, CacheEntry> = new Map();

    constructor() {
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

    private triggerRefresh() {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
        }
        this.refreshTimer = setTimeout(() => {
            this._onDidChangeCodeLenses.fire();
            this.refreshTimer = undefined;
        }, 500); // 500ms debounce
    }

    public refresh(): void {
        this.cache.clear();
        this._onDidChangeCodeLenses.fire();
    }

    private clearCacheForDocument(uri: vscode.Uri) {
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

    public async provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.CodeLens[]> {
        const config = vscode.workspace.getConfiguration('dartReferenceCodeLens');
        if (!config.get<boolean>('enabled')) {
            return [];
        }
        
        const excludePatterns = config.get<string[]>('excludePatterns') || [];
        for (const pattern of excludePatterns) {
            if (vscode.languages.match({ pattern: pattern, scheme: 'file' }, document)) {
                return [];
            }
        }

        const lenses: DartCodeLens[] = [];
        try {
            const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
                'vscode.executeDocumentSymbolProvider',
                document.uri
            );

            if (!symbols || symbols.length === 0) {
                return [];
            }

            this.processSymbols(document, symbols, lenses, config);
        } catch (e) {
            console.error('Error providing code lenses:', e);
        }
        return lenses;
    }

    private processSymbols(
        document: vscode.TextDocument, 
        symbols: vscode.DocumentSymbol[], 
        lenses: DartCodeLens[],
        config: vscode.WorkspaceConfiguration
    ) {
        const showClasses = config.get<boolean>('showClasses');
        const showMethods = config.get<boolean>('showMethods');
        const showProperties = config.get<boolean>('showProperties');
        const showConstructors = config.get<boolean>('showConstructors');
        const showEnums = config.get<boolean>('showEnums'); // Enums handled as Class usually or Enum if supported
        const showVariables = config.get<boolean>('showVariables');
        const ignoredMethodNames = config.get<string[]>('ignoredMethodNames') || [];

        for (const symbol of symbols) {
            let shouldShow = false;

            if (symbol.kind === vscode.SymbolKind.Class && showClasses) {
                shouldShow = true;
            } else if ((symbol.kind === vscode.SymbolKind.Method || symbol.kind === vscode.SymbolKind.Function) && showMethods) {
                shouldShow = true;
            } else if (symbol.kind === vscode.SymbolKind.Property && showProperties) {
                shouldShow = true;
            } else if (symbol.kind === vscode.SymbolKind.Constructor && showConstructors) {
                shouldShow = true;
            } else if (symbol.kind === vscode.SymbolKind.Enum && showEnums) {
                shouldShow = true;
            } else if (symbol.kind === vscode.SymbolKind.Variable && showVariables) {
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

    public async resolveCodeLens(codeLens: DartCodeLens, token: vscode.CancellationToken): Promise<vscode.CodeLens> {
        const config = vscode.workspace.getConfiguration('dartReferenceCodeLens');
        const highlightUnused = config.get<boolean>('highlightUnused');
        const minReferences = config.get<number>('minReferencesToShow') || 0;

        // Check cache
        // We need to know the document version to validate cache
        // However, resolveCodeLens doesn't give us the document implementation directly, only URI.
        // We can try to look it up or use the URI. 
        // Ideally, we passed the version in data or we look up open text documents.
        // For simplicity, we'll try to find the document.
        const doc = vscode.workspace.textDocuments.find(d => d.uri.toString() === codeLens.documentUri.toString());
        const version = doc ? doc.version : 0;
        const cacheKey = codeLens.symbolId;
        
        let refCount: number | undefined;
        
        if (this.cache.has(cacheKey)) {
            const entry = this.cache.get(cacheKey)!;
            if (entry.version === version) {
                refCount = entry.count;
            }
        }

        if (refCount === undefined) {
            try {
                const locations = await vscode.commands.executeCommand<vscode.Location[]>(
                    'vscode.executeReferenceProvider',
                    codeLens.documentUri,
                    codeLens.range.start
                );

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
                
            } catch (e) {
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
        } else {
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
