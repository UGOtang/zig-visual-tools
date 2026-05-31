import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import type { BuildArtifact, BuildSummary, ArtifactSourceFile, ArtifactDependency } from './types';
import {
    fetchBuildSummary,
    artifactExists
} from './buildParser';
import {
    buildBuildGraph,
    formatFileSize,
    formatDuration
} from './buildGraphParser';

// ============================================================================
// Extension Activation
// ============================================================================

export function activate(context: vscode.ExtensionContext) {
    console.log('Zig Visual Tools is now active!');

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    // ----------------------------------------
    // 1. Build Targets TreeView
    // ----------------------------------------
    const buildProvider = new ZigBuildTreeProvider(workspaceRoot);
    const treeView = vscode.window.createTreeView('zigBuildTargets', {
        treeDataProvider: buildProvider,
        showCollapseAll: false
    });

    // Register run step command
    const runStepDisposable = vscode.commands.registerCommand(
        'zig-visual-tools.runStep',
        (node: ZigStepItem) => {
            if (!node) {
                vscode.window.showWarningMessage('No build step selected.');
                return;
            }
            runBuildStep(node.label, workspaceRoot);
        }
    );

    // Register refresh command
    const refreshDisposable = vscode.commands.registerCommand(
        'zig-visual-tools.refreshBuildTargets',
        () => {
            buildProvider.refresh();
        }
    );

    context.subscriptions.push(treeView, runStepDisposable, refreshDisposable);

    // ----------------------------------------
    // 2. Build Artifacts TreeView (enriched)
    // ----------------------------------------
    const artifactsProvider = new BuildArtifactsProvider(workspaceRoot);
    const artifactsTreeView = vscode.window.createTreeView('zigBuildArtifacts', {
        treeDataProvider: artifactsProvider,
        showCollapseAll: true
    });

    // Register refresh artifacts command
    const refreshArtifactsDisposable = vscode.commands.registerCommand(
        'zig-visual-tools.refreshBuildArtifacts',
        () => {
            artifactsProvider.refresh();
        }
    );

    // Register run artifact command
    const runArtifactDisposable = vscode.commands.registerCommand(
        'zig-visual-tools.runArtifact',
        (node: ArtifactTreeItem) => {
            if (!node || !node.artifact) {
                vscode.window.showWarningMessage('No artifact selected.');
                return;
            }
            runArtifact(node.artifact, workspaceRoot);
        }
    );

    // Register debug artifact command
    const debugArtifactDisposable = vscode.commands.registerCommand(
        'zig-visual-tools.debugArtifact',
        (node: ArtifactTreeItem) => {
            if (!node || !node.artifact) {
                vscode.window.showWarningMessage('No artifact selected.');
                return;
            }
            debugArtifact(node.artifact, workspaceRoot);
        }
    );

    // Register rebuild artifact command
    const rebuildArtifactDisposable = vscode.commands.registerCommand(
        'zig-visual-tools.rebuildArtifact',
        (node: ArtifactTreeItem) => {
            if (!node || !node.artifact) {
                vscode.window.showWarningMessage('No artifact selected.');
                return;
            }
            rebuildArtifact(node.artifact, workspaceRoot);
        }
    );

    // Register open artifact folder command
    const openFolderDisposable = vscode.commands.registerCommand(
        'zig-visual-tools.openArtifactFolder',
        (node: ArtifactTreeItem) => {
            if (!node || !node.artifact) {
                vscode.window.showWarningMessage('No artifact selected.');
                return;
            }
            openArtifactFolder(node.artifact);
        }
    );

    // Register open source file command
    // This command can be triggered either:
    // 1. From a TreeItem click (node is ArtifactTreeItem with sourceFile)
    // 2. From context menu (node is ArtifactTreeItem with sourceFile)
    // 3. From command arguments directly (src is ArtifactSourceFile)
    const openSourceFileDisposable = vscode.commands.registerCommand(
        'zig-visual-tools.openSourceFile',
        (arg?: ArtifactTreeItem | ArtifactSourceFile) => {
            // If the argument is an ArtifactSourceFile directly (from item.command.arguments)
            if (arg && typeof arg === 'object' && 'absolutePath' in arg && 'relativePath' in arg) {
                openSourceFile(arg as ArtifactSourceFile);
                return;
            }
            // If the argument is an ArtifactTreeItem
            const node = arg as ArtifactTreeItem | undefined;
            if (node && node.sourceFile) {
                openSourceFile(node.sourceFile);
                return;
            }
            vscode.window.showWarningMessage('No source file selected.');
        }
    );

    // Register show artifact dependencies command
    const showArtifactDepsDisposable = vscode.commands.registerCommand(
        'zig-visual-tools.showArtifactDependencies',
        (node: ArtifactTreeItem) => {
            if (!node || !node.artifact) {
                vscode.window.showWarningMessage('No artifact selected.');
                return;
            }
            showArtifactDependencies(node.artifact, workspaceRoot);
        }
    );

    // Register show artifact graph command
    const showArtifactGraphDisposable = vscode.commands.registerCommand(
        'zig-visual-tools.showArtifactGraph',
        () => {
            showFullBuildGraph(artifactsProvider, workspaceRoot);
        }
    );

    context.subscriptions.push(
        artifactsTreeView,
        refreshArtifactsDisposable,
        runArtifactDisposable,
        debugArtifactDisposable,
        rebuildArtifactDisposable,
        openFolderDisposable,
        openSourceFileDisposable,
        showArtifactDepsDisposable,
        showArtifactGraphDisposable
    );

    // ----------------------------------------
    // 3. Test Controller (Test Explorer)
    // ----------------------------------------
    const testController = vscode.tests.createTestController(
        'zigTestController',
        'Zig Tests'
    );
    context.subscriptions.push(testController);

    // Create run profile
    testController.createRunProfile(
        'Run',
        vscode.TestRunProfileKind.Run,
        (request, token) => runTests(testController, request, token, workspaceRoot),
        true
    );

    // Create debug profile
    testController.createRunProfile(
        'Debug',
        vscode.TestRunProfileKind.Debug,
        (request, token) => runTests(testController, request, token, workspaceRoot),
        true
    );

    // Initial test discovery
    discoverWorkspaceTests(testController, workspaceRoot);

    // Watch for file changes to refresh tests
    if (workspaceRoot) {
        const watcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(workspaceRoot, '**/*.zig')
        );

        watcher.onDidChange(uri => {
            updateTestsForFile(testController, uri.fsPath);
        });

        watcher.onDidCreate(uri => {
            updateTestsForFile(testController, uri.fsPath);
        });

        watcher.onDidDelete(uri => {
            removeTestsForFile(testController, uri.fsPath);
        });

        context.subscriptions.push(watcher);
    }
}

// ============================================================================
// Build Step Execution
// ============================================================================

function runBuildStep(stepName: string, workspaceRoot: string | undefined) {
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
    }

    const terminal = vscode.window.createTerminal({
        name: `Zig Build: ${stepName}`,
        cwd: workspaceRoot
    });
    terminal.show();
    terminal.sendText(`zig build ${stepName}`);
}

// ============================================================================
// Artifact Actions
// ============================================================================

function runArtifact(artifact: BuildArtifact, workspaceRoot: string | undefined) {
    if (!workspaceRoot || !artifact.absolutePath) {
        vscode.window.showErrorMessage('Cannot run artifact: missing path information.');
        return;
    }

    if (!artifactExists(artifact)) {
        vscode.window.showErrorMessage(`Artifact does not exist: ${artifact.name}. Build it first.`);
        return;
    }

    const terminal = vscode.window.createTerminal({
        name: `Run: ${artifact.name}`,
        cwd: workspaceRoot
    });
    terminal.show();
    terminal.sendText(`"${artifact.absolutePath}"`);
}

async function debugArtifact(artifact: BuildArtifact, workspaceRoot: string | undefined) {
    if (!workspaceRoot || !artifact.absolutePath) {
        vscode.window.showErrorMessage('Cannot debug artifact: missing path information.');
        return;
    }

    if (!artifactExists(artifact)) {
        vscode.window.showErrorMessage(`Artifact does not exist: ${artifact.name}. Build it first.`);
        return;
    }

    const config = vscode.workspace.getConfiguration('zigVisualTools');
    const debuggerChoice = config.get<string>('debugger', 'gdb');

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(workspaceRoot));

    if (debuggerChoice === 'lldb') {
        // Use CodeLLDB extension (vadimcn.vscode-lldb)
        const debugConfig: vscode.DebugConfiguration = {
            type: 'lldb',
            name: `Debug ${artifact.name}`,
            request: 'launch',
            program: artifact.absolutePath,
            cwd: workspaceRoot,
            args: [],
            stopAtEntry: false
        };

        let success = false;
        try {
            success = await vscode.debug.startDebugging(workspaceFolder, debugConfig);
        } catch {
            // CodeLLDB not installed or misconfigured
        }

        if (!success) {
            vscode.window.showErrorMessage(
                'Failed to start LLDB debug session. Make sure the CodeLLDB extension (vadimcn.vscode-lldb) is installed.',
                'Install CodeLLDB'
            ).then(choice => {
                if (choice === 'Install CodeLLDB') {
                    vscode.commands.executeCommand('workbench.extensions.installExtension', 'vadimcn.vscode-lldb');
                }
            });
        }
    } else {
        // Use GDB via C/C++ extension (ms-vscode.cpptools) — default
        const debugConfig: vscode.DebugConfiguration = {
            type: 'cppdbg',
            name: `Debug ${artifact.name}`,
            request: 'launch',
            program: artifact.absolutePath,
            cwd: workspaceRoot,
            args: [],
            stopAtEntry: false,
            MIMode: 'gdb',
            setupCommands: [
                {
                    description: 'Enable pretty-printing for gdb',
                    text: '-enable-pretty-printing',
                    ignoreFailures: true
                }
            ]
        };

        let success = false;
        try {
            success = await vscode.debug.startDebugging(workspaceFolder, debugConfig);
        } catch {
            // C/C++ extension not installed or misconfigured
        }

        if (!success) {
            vscode.window.showErrorMessage(
                'Failed to start GDB debug session. Make sure the C/C++ extension (ms-vscode.cpptools) is installed.',
                'Install C/C++ Extension'
            ).then(choice => {
                if (choice === 'Install C/C++ Extension') {
                    vscode.commands.executeCommand('workbench.extensions.installExtension', 'ms-vscode.cpptools');
                }
            });
        }
    }
}

function rebuildArtifact(artifact: BuildArtifact, workspaceRoot: string | undefined) {
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
    }

    const terminal = vscode.window.createTerminal({
        name: `Rebuild: ${artifact.name}`,
        cwd: workspaceRoot
    });
    terminal.show();
    // Run the build step for this artifact
    terminal.sendText(`zig build ${artifact.name} && echo "Build succeeded: ${artifact.name}"`);
}

function openArtifactFolder(artifact: BuildArtifact) {
    if (!artifact.absolutePath) {
        vscode.window.showErrorMessage('Cannot find artifact location.');
        return;
    }

    const folderPath = path.dirname(artifact.absolutePath);
    vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(folderPath));
}

async function openSourceFile(sourceFile: ArtifactSourceFile) {
    const filePath = sourceFile.absolutePath;

    // Check if file exists
    try {
        await fs.promises.access(filePath, fs.constants.R_OK);
    } catch {
        vscode.window.showErrorMessage(`File not found: ${filePath}`);
        return;
    }

    const uri = vscode.Uri.file(filePath);
    try {
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Cannot open file: ${message}`);
    }
}

/**
 * Show artifact dependencies in a quick pick
 */
async function showArtifactDependencies(artifact: BuildArtifact, workspaceRoot: string | undefined) {
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
    }

    const deps = artifact.dependencies;
    if (!deps || deps.length === 0) {
        vscode.window.showInformationMessage(`No dependencies for ${artifact.name}`);
        return;
    }

    const items: vscode.QuickPickItem[] = deps.map(dep => ({
        label: dep.name,
        description: dep.kind,
        detail: dep.isTransitive ? 'Transitive dependency' : 'Direct dependency'
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Dependencies of ${artifact.name}`,
        title: `Artifact Dependencies: ${artifact.name}`
    });

    if (selected) {
        // Navigate to workspace files related to this dependency
        const depName = selected.label;
        const depStep = deps.find(d => d.name === depName);
        if (depStep?.step) {
            vscode.window.showInformationMessage(
                `Dependency: ${depName} (${depStep.kind}) - build time: ${formatDuration(depStep.step.duration)}`
            );
        }
    }
}

/**
 * Show the full build dependency graph in a new editor panel
 */
async function showFullBuildGraph(
    provider: BuildArtifactsProvider,
    workspaceRoot: string | undefined
) {
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace folder open.');
        return;
    }

    const summary = provider.getLastSummary();
    if (!summary) {
        vscode.window.showInformationMessage(
            'No build data available. Please refresh the Build Artifacts view first.'
        );
        return;
    }

    // Build the graph content as a text document
    const graphContent = await buildGraphVisualization(summary, workspaceRoot);

    // Create and show a new untitled document
    const doc = await vscode.workspace.openTextDocument({
        content: graphContent,
        language: 'plaintext'
    });
    vscode.window.showTextDocument(doc);
}

/**
 * Build a text visualization of the artifact dependency graph
 */
async function buildGraphVisualization(
    summary: BuildSummary,
    workspaceRoot: string
): Promise<string> {
    const graphContext = buildBuildGraph(summary, workspaceRoot);
    const lines: string[] = [];

    lines.push('╔══════════════════════════════════════════╗');
    lines.push('║     Zig Build Dependency Graph           ║');
    lines.push('╚══════════════════════════════════════════╝');
    lines.push('');
    lines.push(`Build: ${summary.succeededSteps}/${summary.totalSteps} steps succeeded`);
    lines.push(`Timestamp: ${summary.timestamp.toLocaleString()}`);
    lines.push('');

    for (const artifact of graphContext.artifacts) {
        const exists = artifactExists(artifact);
        const statusIcon = exists ? '✓' : '✗';
        const fileSizeStr = formatFileSize(artifact.fileSize);

        // Determine artifact kind description
        let kindDesc: string;
        if (artifact.kind === 'exe') {
            kindDesc = artifact.isTest ? 'Test Executable' : 'Executable';
        } else if (artifact.kind === 'lib') {
            kindDesc = artifact.isDynamic ? 'Shared Library' : 'Static Library';
        } else {
            kindDesc = 'Object File';
        }

        lines.push(`┌─ ${statusIcon} ${artifact.name}`);
        lines.push(`│  Kind: ${kindDesc}`);
        lines.push(`│  Path: ${artifact.path}`);

        if (artifact.optimize) {
            lines.push(`│  Build Mode: ${artifact.optimize}`);
        }
        if (artifact.target) {
            lines.push(`│  Target: ${artifact.target}`);
        }
        if (fileSizeStr) {
            lines.push(`│  Size: ${fileSizeStr}`);
        }

        // Source files
        const sourceFiles = artifact.sourceFiles || [];
        if (sourceFiles.length > 0) {
            // Group by language
            const byLang = new Map<string, number>();
            for (const src of sourceFiles) {
                const lang = src.language || 'unknown';
                byLang.set(lang, (byLang.get(lang) || 0) + 1);
            }
            const langSummary = Array.from(byLang.entries())
                .map(([lang, count]) => `${count} ${lang}`)
                .join(', ');

            lines.push(`│  Source Files (${sourceFiles.length}): ${langSummary}`);
            for (const src of sourceFiles) {
                const rootMarker = src.isRootSource ? ' [root]' : '';
                const langLabel = src.language ? `[${src.language}] ` : '';
                lines.push(`│    ├─ ${langLabel}${src.relativePath} (${src.lineCount} lines)${rootMarker}`);
            }
        }

        // Dependencies
        const deps = artifact.dependencies || [];
        if (deps.length > 0) {
            lines.push(`│  Dependencies (${deps.length}):`);
            for (const dep of deps) {
                const transitive = dep.isTransitive ? ' [transitive]' : '';
                lines.push(`│    └─ ${dep.name} (${dep.kind})${transitive}`);
            }
        } else {
            lines.push(`│  Dependencies: (none)`);
        }

        lines.push(`└─${'─'.repeat(40)}`);
        lines.push('');
    }

    // Summary statistics
    lines.push('═══════════════════════════════════════════');
    lines.push('Summary:');
    lines.push(`  Total artifacts: ${graphContext.artifacts.length}`);
    const exeCount = graphContext.artifacts.filter(a => a.kind === 'exe' && !a.isTest).length;
    const testCount = graphContext.artifacts.filter(a => a.kind === 'exe' && a.isTest).length;
    const staticLibCount = graphContext.artifacts.filter(a => a.kind === 'lib' && !a.isDynamic).length;
    const dynamicLibCount = graphContext.artifacts.filter(a => a.kind === 'lib' && a.isDynamic).length;
    const objCount = graphContext.artifacts.filter(a => a.kind === 'obj').length;
    lines.push(`  Executables: ${exeCount}`);
    if (testCount > 0) {
        lines.push(`  Test Executables: ${testCount}`);
    }
    if (staticLibCount > 0) {
        lines.push(`  Static Libraries: ${staticLibCount}`);
    }
    if (dynamicLibCount > 0) {
        lines.push(`  Shared Libraries: ${dynamicLibCount}`);
    }
    if (objCount > 0) {
        lines.push(`  Object Files: ${objCount}`);
    }

    return lines.join('\n');
}

// ============================================================================
// Build Targets Tree Provider
// ============================================================================

class ZigBuildTreeProvider implements vscode.TreeDataProvider<ZigStepItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ZigStepItem | undefined | null | void> =
        new vscode.EventEmitter<ZigStepItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ZigStepItem | undefined | null | void> =
        this._onDidChangeTreeData.event;

    constructor(private workspaceRoot: string | undefined) {}

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: ZigStepItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ZigStepItem): Promise<ZigStepItem[]> {
        if (!this.workspaceRoot) {
            vscode.window.showInformationMessage('No workspace folder open.');
            return [];
        }

        if (element) {
            // No children for leaf nodes
            return [];
        }

        // Check if build.zig exists
        const buildZigPath = path.join(this.workspaceRoot, 'build.zig');
        try {
            await fs.promises.access(buildZigPath, fs.constants.R_OK);
        } catch {
            return [new ZigStepItem(
                'No build.zig found',
                'Open a Zig project with a build.zig file',
                vscode.TreeItemCollapsibleState.None,
                true
            )];
        }

        try {
            const steps = await this.parseZigBuildSteps();
            if (steps.length === 0) {
                return [new ZigStepItem(
                    'No build steps found',
                    'Run "zig build --help" to see available steps',
                    vscode.TreeItemCollapsibleState.None,
                    true
                )];
            }
            return steps.map(s => new ZigStepItem(
                s.name,
                s.description,
                vscode.TreeItemCollapsibleState.None
            ));
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(
                `Failed to run 'zig build --help': ${errorMessage}. Check your Zig installation.`
            );
            return [new ZigStepItem(
                'Error loading build steps',
                errorMessage,
                vscode.TreeItemCollapsibleState.None,
                true
            )];
        }
    }

    private parseZigBuildSteps(): Promise<{ name: string; description: string }[]> {
        return new Promise((resolve, reject) => {
            cp.exec(
                'zig build --help',
                { cwd: this.workspaceRoot, timeout: 30000 },
                (error: cp.ExecException | null, stdout: string, _stderr: string) => {
                    if (error && !stdout) {
                        reject(error);
                        return;
                    }

                    const steps: { name: string; description: string }[] = [];
                    const lines = stdout.split('\n');
                    let inStepsSection = false;

                    for (const line of lines) {
                        const trimmedLine = line.trim();

                        if (trimmedLine.startsWith('Steps:')) {
                            inStepsSection = true;
                            continue;
                        }

                        if (inStepsSection) {
                            if (trimmedLine === '') {
                                // Empty line marks end of Steps section
                                break;
                            }

                            // Match lines like:
                            //   install (default)            Copy build artifacts to prefix path
                            //   build                        Compile the project
                            const match = line.match(/^\s+([a-zA-Z0-9_\-]+)(?:\s+\(default\))?\s+(.+)$/);
                            if (match) {
                                steps.push({
                                    name: match[1],
                                    description: match[2].trim()
                                });
                            } else {
                                // Try simpler format: just step name
                                const simpleMatch = line.match(/^\s+([a-zA-Z0-9_\-]+)\s*$/);
                                if (simpleMatch) {
                                    steps.push({
                                        name: simpleMatch[1],
                                        description: ''
                                    });
                                }
                            }
                        }
                    }

                    resolve(steps);
                }
            );
        });
    }
}

class ZigStepItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        private readonly descriptionText: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        isPlaceholder: boolean = false
    ) {
        super(label, collapsibleState);
        this.tooltip = this.descriptionText || this.label;
        this.description = this.descriptionText;

        if (!isPlaceholder) {
            this.contextValue = 'zigStep';
            this.iconPath = new vscode.ThemeIcon('wrench');
        } else {
            this.contextValue = 'zigStepPlaceholder';
            this.iconPath = new vscode.ThemeIcon('info');
        }
    }
}

// ============================================================================
// Build Artifacts Tree Provider (Enriched with source files & dependencies)
// ============================================================================

class BuildArtifactsProvider implements vscode.TreeDataProvider<ArtifactTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ArtifactTreeItem | undefined | null | void> =
        new vscode.EventEmitter<ArtifactTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ArtifactTreeItem | undefined | null | void> =
        this._onDidChangeTreeData.event;

    private summary: BuildSummary | null = null;
    private enrichedArtifacts: BuildArtifact[] = [];

    constructor(private workspaceRoot: string | undefined) {}

    refresh(): void {
        this.summary = null;
        this.enrichedArtifacts = [];
        this._onDidChangeTreeData.fire();
    }

    /**
     * Get the last build summary (for dependency graph visualization)
     */
    getLastSummary(): BuildSummary | null {
        return this.summary;
    }

    getTreeItem(element: ArtifactTreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: ArtifactTreeItem): Promise<ArtifactTreeItem[]> {
        if (!this.workspaceRoot) {
            return [new ArtifactTreeItem(
                'no-workspace',
                'No workspace folder open',
                vscode.TreeItemCollapsibleState.None,
                'placeholder'
            )];
        }

        // If we have an element that already has children computed, return them
        if (element && element.children && element.children.length > 0) {
            return element.children;
        }

        // Load build summary if not cached
        if (!this.summary) {
            try {
                this.summary = await fetchBuildSummary(this.workspaceRoot);
                // Enrich artifacts with source file and dependency info
                const graphContext = buildBuildGraph(this.summary, this.workspaceRoot);
                this.enrichedArtifacts = graphContext.artifacts;
            } catch (err) {
                const errorMessage = err instanceof Error ? err.message : String(err);
                return [new ArtifactTreeItem(
                    'error',
                    `Error: ${errorMessage}`,
                    vscode.TreeItemCollapsibleState.None,
                    'placeholder'
                )];
            }
        }

        // Root level: show categories
        if (!element) {
            const items: ArtifactTreeItem[] = [];

            // Executables (filter out test executables to a separate category)
            const exes = this.enrichedArtifacts.filter(a => a.kind === 'exe' && !a.isTest);
            if (exes.length > 0) {
                const exeFolder = new ArtifactTreeItem(
                    'executables',
                    'Executables',
                    vscode.TreeItemCollapsibleState.Expanded,
                    'folder',
                    new vscode.ThemeIcon('package')
                );
                exeFolder.children = exes.map(artifact => this.createArtifactItem(artifact));
                items.push(exeFolder);
            }

            // Libraries - separate static and dynamic
            const libs = this.enrichedArtifacts.filter(a => a.kind === 'lib');
            if (libs.length > 0) {
                const staticLibs = libs.filter(l => !l.isDynamic);
                const dynamicLibs = libs.filter(l => l.isDynamic);

                if (staticLibs.length > 0) {
                    const staticFolder = new ArtifactTreeItem(
                        'static-libraries',
                        `Static Libraries (${staticLibs.length})`,
                        vscode.TreeItemCollapsibleState.Expanded,
                        'folder',
                        new vscode.ThemeIcon('library')
                    );
                    staticFolder.children = staticLibs.map(artifact => this.createArtifactItem(artifact));
                    items.push(staticFolder);
                }

                if (dynamicLibs.length > 0) {
                    const dynamicFolder = new ArtifactTreeItem(
                        'dynamic-libraries',
                        `Shared Libraries (${dynamicLibs.length})`,
                        vscode.TreeItemCollapsibleState.Expanded,
                        'folder',
                        new vscode.ThemeIcon('package')
                    );
                    dynamicFolder.children = dynamicLibs.map(artifact => this.createArtifactItem(artifact));
                    items.push(dynamicFolder);
                }
            }

            // Object files
            const objs = this.enrichedArtifacts.filter(a => a.kind === 'obj');
            if (objs.length > 0) {
                const objFolder = new ArtifactTreeItem(
                    'objects',
                    `Object Files (${objs.length})`,
                    vscode.TreeItemCollapsibleState.Expanded,
                    'folder',
                    new vscode.ThemeIcon('file-binary')
                );
                objFolder.children = objs.map(artifact => this.createArtifactItem(artifact));
                items.push(objFolder);
            }

            // Test executables
            const tests = this.enrichedArtifacts.filter(a => a.kind === 'exe' && a.isTest);
            if (tests.length > 0) {
                const testFolder = new ArtifactTreeItem(
                    'test-executables',
                    `Test Executables (${tests.length})`,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'folder',
                    new vscode.ThemeIcon('beaker')
                );
                testFolder.children = tests.map(artifact => this.createArtifactItem(artifact));
                items.push(testFolder);
            }

            // Summary info
            const info = new ArtifactTreeItem(
                'summary',
                `${this.summary.succeededSteps}/${this.summary.totalSteps} steps`,
                vscode.TreeItemCollapsibleState.Expanded,
                'info',
                new vscode.ThemeIcon('info')
            );
            info.description = this.summary.success ? '✓ Build succeeded' : '✗ Build failed';

            // Add enriched statistics as children of the info node
            const infoChildren: ArtifactTreeItem[] = [];
            infoChildren.push(new ArtifactTreeItem(
                'total-artifacts',
                `Artifacts: ${this.enrichedArtifacts.length}`,
                vscode.TreeItemCollapsibleState.None,
                'info-detail',
                new vscode.ThemeIcon('circuit-board')
            ));
            infoChildren.push(new ArtifactTreeItem(
                'total-src-files',
                `Source Files: ${this.getTotalSourceFileCount()}`,
                vscode.TreeItemCollapsibleState.None,
                'info-detail',
                new vscode.ThemeIcon('file')
            ));
            infoChildren.push(new ArtifactTreeItem(
                'total-deps',
                `Dependencies: ${this.getTotalDependencyCount()}`,
                vscode.TreeItemCollapsibleState.None,
                'info-detail',
                new vscode.ThemeIcon('references')
            ));
            info.children = infoChildren;

            items.push(info);

            return items;
        }

        // Handle specific artifact children
        if (element.artifact) {
            return this.getArtifactChildren(element.artifact);
        }

        return [];
    }

    /**
     * Get source file and dependency children for an artifact
     */
    private getArtifactChildren(artifact: BuildArtifact): ArtifactTreeItem[] {
        const children: ArtifactTreeItem[] = [];

        // Source files section - group by directory
        const sourceFiles = artifact.sourceFiles || [];
        if (sourceFiles.length > 0) {
            // Count files by language
            const zigCount = sourceFiles.filter(s => s.language === 'zig').length;
            const cCount = sourceFiles.filter(s => s.language === 'c').length;
            const cppCount = sourceFiles.filter(s => s.language === 'cpp').length;
            const headerCount = sourceFiles.filter(s => s.language === 'header').length;

            // Build description showing breakdown
            const parts: string[] = [];
            if (zigCount > 0) {
                parts.push(`${zigCount} Zig`);
            }
            if (cCount > 0) {
                parts.push(`${cCount} C`);
            }
            if (cppCount > 0) {
                parts.push(`${cppCount} C++`);
            }
            if (headerCount > 0) {
                parts.push(`${headerCount} H`);
            }

            const srcFolder = new ArtifactTreeItem(
                `sources-${artifact.name}`,
                `Source Files (${sourceFiles.length})`,
                vscode.TreeItemCollapsibleState.Expanded,
                'source-folder',
                new vscode.ThemeIcon('file-directory')
            );
            srcFolder.description = parts.join(', ');

            // Group source files by directory
            const filesByDir = new Map<string, ArtifactSourceFile[]>();
            for (const src of sourceFiles) {
                const dir = path.dirname(src.relativePath);
                if (!filesByDir.has(dir)) {
                    filesByDir.set(dir, []);
                }
                filesByDir.get(dir)!.push(src);
            }

            // Sort directories (root first, then alphabetically)
            const sortedDirs = Array.from(filesByDir.keys()).sort((a, b) => {
                if (a === '.') { return -1; }
                if (b === '.') { return 1; }
                return a.localeCompare(b);
            });

            // Create folder structure
            const folderItems: ArtifactTreeItem[] = [];

            for (const dir of sortedDirs) {
                const files = filesByDir.get(dir)!;
                // Sort files: root source first, then by name
                files.sort((a, b) => {
                    if (a.isRootSource && !b.isRootSource) { return -1; }
                    if (!a.isRootSource && b.isRootSource) { return 1; }
                    return a.name.localeCompare(b.name);
                });

                if (dir === '.') {
                    // Root level files - add directly
                    for (const src of files) {
                        folderItems.push(this.createSourceFileItem(src, artifact.name));
                    }
                } else {
                    // Create folder node
                    const dirName = dir.split('/').pop() || dir;
                    const folderItem = new ArtifactTreeItem(
                        `folder-${artifact.name}-${dir}`,
                        dirName,
                        vscode.TreeItemCollapsibleState.Collapsed,
                        'source-directory',
                        new vscode.ThemeIcon('folder')
                    );
                    folderItem.description = `${files.length} files`;
                    folderItem.tooltip = `Directory: ${dir}`;

                    // Add files as children
                    folderItem.children = files.map(src => this.createSourceFileItem(src, artifact.name));
                    folderItems.push(folderItem);
                }
            }

            srcFolder.children = folderItems;
            children.push(srcFolder);
        } else {
            const noSrc = new ArtifactTreeItem(
                `no-sources-${artifact.name}`,
                'No source files found',
                vscode.TreeItemCollapsibleState.None,
                'info-detail',
                new vscode.ThemeIcon('info')
            );
            children.push(noSrc);
        }

        // Dependencies section
        const deps = artifact.dependencies || [];
        if (deps.length > 0) {
            // Group dependencies by kind for better organization
            const exeDeps = deps.filter(d => d.kind === 'exe');
            const libDeps = deps.filter(d => d.kind === 'lib');
            const objDeps = deps.filter(d => d.kind === 'obj');

            const depFolder = new ArtifactTreeItem(
                `deps-${artifact.name}`,
                `Dependencies (${deps.length})`,
                vscode.TreeItemCollapsibleState.Expanded,
                'dependency-folder',
                new vscode.ThemeIcon('references')
            );

            // Build description showing breakdown
            const depParts: string[] = [];
            if (exeDeps.length > 0) {
                depParts.push(`${exeDeps.length} exe`);
            }
            if (libDeps.length > 0) {
                depParts.push(`${libDeps.length} lib`);
            }
            if (objDeps.length > 0) {
                depParts.push(`${objDeps.length} obj`);
            }
            depFolder.description = depParts.join(', ');

            // Create dependency items grouped by kind
            const depItems: ArtifactTreeItem[] = [];

            // Add executables group
            if (exeDeps.length > 0) {
                const exeFolder = new ArtifactTreeItem(
                    `deps-exe-${artifact.name}`,
                    `Executables (${exeDeps.length})`,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'dependency-group',
                    new vscode.ThemeIcon('play')
                );
                exeFolder.children = exeDeps.map(dep => this.createDependencyItem(dep, artifact.name));
                depItems.push(exeFolder);
            }

            // Add libraries group
            if (libDeps.length > 0) {
                const libFolder = new ArtifactTreeItem(
                    `deps-lib-${artifact.name}`,
                    `Libraries (${libDeps.length})`,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'dependency-group',
                    new vscode.ThemeIcon('library')
                );
                libFolder.children = libDeps.map(dep => this.createDependencyItem(dep, artifact.name));
                depItems.push(libFolder);
            }

            // Add object files group
            if (objDeps.length > 0) {
                const objFolder = new ArtifactTreeItem(
                    `deps-obj-${artifact.name}`,
                    `Object Files (${objDeps.length})`,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    'dependency-group',
                    new vscode.ThemeIcon('file-binary')
                );
                objFolder.children = objDeps.map(dep => this.createDependencyItem(dep, artifact.name));
                depItems.push(objFolder);
            }

            depFolder.children = depItems;
            children.push(depFolder);
        }

        // Artifact info section
        const infoFolder = new ArtifactTreeItem(
            `info-${artifact.name}`,
            'Details',
            vscode.TreeItemCollapsibleState.Expanded,
            'info-folder',
            new vscode.ThemeIcon('info')
        );
        const infoChildren: ArtifactTreeItem[] = [];

        // File size
        if (artifact.fileSize !== undefined) {
            const sizeItem = new ArtifactTreeItem(
                `size-${artifact.name}`,
                `Size: ${formatFileSize(artifact.fileSize)}`,
                vscode.TreeItemCollapsibleState.None,
                'info-detail'
            );
            infoChildren.push(sizeItem);
        }

        // Build mode
        if (artifact.optimize) {
            const optItem = new ArtifactTreeItem(
                `opt-${artifact.name}`,
                `Build: ${artifact.optimize}`,
                vscode.TreeItemCollapsibleState.None,
                'info-detail'
            );
            infoChildren.push(optItem);
        }

        // Library type (static vs dynamic)
        if (artifact.kind === 'lib') {
            const libTypeItem = new ArtifactTreeItem(
                `libtype-${artifact.name}`,
                `Type: ${artifact.isDynamic ? 'Shared Library (.so/.dylib/.dll)' : 'Static Library (.a)'}`,
                vscode.TreeItemCollapsibleState.None,
                'info-detail',
                new vscode.ThemeIcon(artifact.isDynamic ? 'package' : 'library')
            );
            infoChildren.push(libTypeItem);
        }

        // Target
        if (artifact.target) {
            const targetItem = new ArtifactTreeItem(
                `target-${artifact.name}`,
                `Target: ${artifact.target}`,
                vscode.TreeItemCollapsibleState.None,
                'info-detail'
            );
            infoChildren.push(targetItem);
        }

        // Path
        if (artifact.path) {
            const pathItem = new ArtifactTreeItem(
                `path-${artifact.name}`,
                `Path: ${artifact.path}`,
                vscode.TreeItemCollapsibleState.None,
                'info-detail'
            );
            infoChildren.push(pathItem);
        }

        // Is test
        if (artifact.isTest) {
            const testItem = new ArtifactTreeItem(
                `test-${artifact.name}`,
                'Test executable',
                vscode.TreeItemCollapsibleState.None,
                'info-detail'
            );
            infoChildren.push(testItem);
        }

        infoFolder.children = infoChildren;
        children.push(infoFolder);

        return children;
    }

    private createArtifactItem(artifact: BuildArtifact): ArtifactTreeItem {
        const exists = artifactExists(artifact);
        const contextValue = artifact.kind === 'exe' ? 'zigArtifactExe' :
                            artifact.kind === 'lib' ? 'zigArtifactLib' :
                            'zigArtifactObj';

        // Determine icon based on artifact kind and type
        let icon: vscode.ThemeIcon;
        if (artifact.kind === 'exe') {
            icon = new vscode.ThemeIcon('play');
        } else if (artifact.kind === 'lib') {
            // Use different icon for dynamic vs static libraries
            icon = artifact.isDynamic
                ? new vscode.ThemeIcon('package')  // Dynamic/shared library
                : new vscode.ThemeIcon('library'); // Static library
        } else {
            icon = new vscode.ThemeIcon('file-binary');
        }

        const item = new ArtifactTreeItem(
            artifact.name,
            artifact.name,
            vscode.TreeItemCollapsibleState.Collapsed,
            contextValue,
            icon,
            artifact
        );

        // Add status indicator
        const statusParts: string[] = [];
        statusParts.push(exists ? '✓' : '✗ Not built');

        if (artifact.optimize) {
            statusParts.push(`[${artifact.optimize}]`);
        }

        // Add library type indicator
        if (artifact.kind === 'lib') {
            statusParts.push(artifact.isDynamic ? '(shared)' : '(static)');
        }

        // Add file size if available
        if (artifact.fileSize !== undefined) {
            statusParts.push(formatFileSize(artifact.fileSize));
        }

        // Add source file count
        if (artifact.sourceFiles && artifact.sourceFiles.length > 0) {
            statusParts.push(`${artifact.sourceFiles.length} src`);
        }

        // Add dependency count
        if (artifact.dependencies && artifact.dependencies.length > 0) {
            statusParts.push(`${artifact.dependencies.length} deps`);
        }

        item.description = statusParts.join(' ');

        // Build tooltip with detailed info
        let tooltipLines = [
            `${artifact.name}`,
            `Kind: ${artifact.kind === 'exe' ? 'Executable' : artifact.kind === 'lib' ? (artifact.isDynamic ? 'Shared Library' : 'Static Library') : 'Object File'}`,
            `Path: ${artifact.path}`
        ];

        if (artifact.optimize) {
            tooltipLines.push(`Build Mode: ${artifact.optimize}`);
        }
        if (artifact.target && artifact.target !== 'dynamic' && artifact.target !== 'static') {
            tooltipLines.push(`Target: ${artifact.target}`);
        }
        if (exists && artifact.fileSize !== undefined) {
            tooltipLines.push(`Size: ${formatFileSize(artifact.fileSize)}`);
        }
        tooltipLines.push(`Sources: ${artifact.sourceFiles?.length || 0}`);
        tooltipLines.push(`Dependencies: ${artifact.dependencies?.length || 0}`);

        item.tooltip = tooltipLines.join('\n');

        return item;
    }

    /**
     * Create a tree item for a source file
     */
    private createSourceFileItem(src: ArtifactSourceFile, artifactName: string): ArtifactTreeItem {
        const rootMarker = src.isRootSource ? ' [root]' : '';

        // Determine icon based on language
        let icon: vscode.ThemeIcon;
        switch (src.language) {
            case 'c':
                icon = new vscode.ThemeIcon('file-code', new vscode.ThemeColor('debugIcon.breakpointForeground'));
                break;
            case 'cpp':
                icon = new vscode.ThemeIcon('file-code', new vscode.ThemeColor('symbolIcon.classForeground'));
                break;
            case 'header':
                icon = new vscode.ThemeIcon('file-code', new vscode.ThemeColor('symbolIcon.interfaceForeground'));
                break;
            case 'zig':
            default:
                icon = new vscode.ThemeIcon(src.isRootSource ? 'file-code' : 'file');
                break;
        }

        const item = new ArtifactTreeItem(
            `src-${artifactName}-${src.relativePath}`,
            src.name,
            vscode.TreeItemCollapsibleState.None,
            'file',  // contextValue must match package.json menu: viewItem == file
            icon,
            undefined,
            src
        );

        // Show language and line count in description
        const langLabel = src.language === 'zig' ? 'Zig' :
                         src.language === 'c' ? 'C' :
                         src.language === 'cpp' ? 'C++' :
                         src.language === 'header' ? 'Header' :
                         src.language === 'objc' ? 'Obj-C' : 'Unknown';
        item.description = `${langLabel}, ${src.lineCount} lines${rootMarker}`;

        // Build tooltip with more details
        const tooltipLines = [
            `${src.name}`,
            `Path: ${src.relativePath}`,
            `Language: ${langLabel}`,
            `Lines: ${src.lineCount}`
        ];
        if (src.isRootSource) {
            tooltipLines.push('Type: Root source file');
        }
        item.tooltip = tooltipLines.join('\n');

        item.command = {
            command: 'zig-visual-tools.openSourceFile',
            title: 'Open Source File',
            arguments: [src]  // Pass ArtifactSourceFile directly
        };

        return item;
    }

    /**
     * Create a tree item for a dependency
     */
    private createDependencyItem(dep: ArtifactDependency, parentArtifactName: string): ArtifactTreeItem {
        const transitive = dep.isTransitive ? ' [transitive]' : '';

        // Determine icon based on dependency kind
        let icon: vscode.ThemeIcon;
        switch (dep.kind) {
            case 'exe':
                icon = new vscode.ThemeIcon('play');
                break;
            case 'lib':
                icon = new vscode.ThemeIcon('library');
                break;
            case 'obj':
                icon = new vscode.ThemeIcon('file-binary');
                break;
            default:
                icon = new vscode.ThemeIcon('package');
        }

        const item = new ArtifactTreeItem(
            `dep-${parentArtifactName}-${dep.name}`,
            dep.name,
            vscode.TreeItemCollapsibleState.None,
            'dependency',
            icon
        );

        // Build description
        const typeLabel = dep.isTransitive ? 'transitive' : 'direct';
        item.description = `${dep.kind}, ${typeLabel}`;

        // Build tooltip with detailed info
        const tooltipLines = [
            `${dep.name}`,
            `Kind: ${dep.kind === 'exe' ? 'Executable' : dep.kind === 'lib' ? 'Library' : 'Object File'}`,
            `Type: ${dep.isTransitive ? 'Transitive dependency' : 'Direct dependency'}`
        ];

        // Add build step info if available
        if (dep.step) {
            tooltipLines.push(`Step: ${dep.step.name}`);
            if (dep.step.status) {
                tooltipLines.push(`Status: ${dep.step.status}`);
            }
            if (dep.step.duration) {
                tooltipLines.push(`Duration: ${formatDuration(dep.step.duration)}`);
            }
        }

        item.tooltip = tooltipLines.join('\n');

        // Add command to show dependency details or navigate to it
        item.command = {
            command: 'zig-visual-tools.showArtifactDependencies',
            title: 'Show Dependency Info',
            arguments: [dep]
        };

        return item;
    }

    private getTotalSourceFileCount(): number {
        const seen = new Set<string>();
        for (const artifact of this.enrichedArtifacts) {
            for (const src of artifact.sourceFiles || []) {
                seen.add(src.absolutePath);
            }
        }
        return seen.size;
    }

    private getTotalDependencyCount(): number {
        const seen = new Set<string>();
        for (const artifact of this.enrichedArtifacts) {
            for (const dep of artifact.dependencies || []) {
                seen.add(dep.name);
            }
        }
        return seen.size;
    }
}

class ArtifactTreeItem extends vscode.TreeItem {
    children?: ArtifactTreeItem[];

    constructor(
        public readonly id: string,
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly contextValue: string,
        public readonly iconPath?: vscode.ThemeIcon,
        public readonly artifact?: BuildArtifact,
        public readonly sourceFile?: ArtifactSourceFile
    ) {
        super(label, collapsibleState);
    }
}

// ============================================================================
// Test Discovery and Execution
// ============================================================================

async function discoverWorkspaceTests(
    controller: vscode.TestController,
    workspaceRoot: string | undefined
): Promise<void> {
    if (!workspaceRoot) {
        return;
    }

    const pattern = new vscode.RelativePattern(workspaceRoot, '**/*.zig');
    const files = await vscode.workspace.findFiles(pattern, '**/zig-out/**');

    for (const file of files) {
        await updateTestsForFile(controller, file.fsPath);
    }
}

async function updateTestsForFile(
    controller: vscode.TestController,
    filePath: string
): Promise<void> {
    // Remove existing tests for this file
    removeTestsForFile(controller, filePath);

    // Check if file exists
    try {
        await fs.promises.access(filePath, fs.constants.R_OK);
    } catch {
        return;
    }

    // Read file content
    let content: string;
    try {
        content = await fs.promises.readFile(filePath, 'utf8');
    } catch {
        return;
    }

    // Parse test declarations
    const testRegex = /test\s+(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*))\s*\{/g;
    let match;

    const fileUri = vscode.Uri.file(filePath);

    while ((match = testRegex.exec(content)) !== null) {
        const testName = match[1] || match[2];
        if (!testName) {
            continue;
        }

        // Create unique ID
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(fileUri);
        const relativePath = workspaceFolder
            ? path.relative(workspaceFolder.uri.fsPath, filePath)
            : filePath;
        const testId = `${relativePath}:${testName}`;

        const testItem = controller.createTestItem(testId, testName, fileUri);

        // Calculate line number for navigation
        const linesBefore = content.substring(0, match.index).split('\n');
        const lineNum = linesBefore.length - 1;
        testItem.range = new vscode.Range(lineNum, 0, lineNum, match[0].length);

        controller.items.add(testItem);
    }
}

function removeTestsForFile(controller: vscode.TestController, filePath: string): void {
    const toRemove: string[] = [];

    controller.items.forEach(item => {
        if (item.uri?.fsPath === filePath) {
            toRemove.push(item.id);
        }
    });

    for (const id of toRemove) {
        controller.items.delete(id);
    }
}

async function runTests(
    controller: vscode.TestController,
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    workspaceRoot: string | undefined
): Promise<void> {
    const run = controller.createTestRun(request);
    const queue: vscode.TestItem[] = [];

    // Build queue of tests to run
    if (request.include) {
        request.include.forEach(test => queue.push(test));
    } else {
        controller.items.forEach(test => queue.push(test));
    }

    for (const test of queue) {
        if (token.isCancellationRequested) {
            run.skipped(test);
            continue;
        }

        const filePath = test.uri?.fsPath;
        if (!filePath || !workspaceRoot) {
            run.skipped(test);
            continue;
        }

        run.started(test);

        const testName = test.label;
        const cmd = `zig test "${filePath}" --test-filter "${testName}"`;

        try {
            await new Promise<void>((resolve) => {
                cp.exec(
                    cmd,
                    {
                        cwd: workspaceRoot,
                        timeout: 60000,
                        maxBuffer: 1024 * 1024 * 10
                    },
                    (error: cp.ExecException | null, stdout: string, stderr: string) => {
                        if (token.isCancellationRequested) {
                            run.skipped(test);
                        } else if (error) {
                            const message = stderr || stdout || error.message;
                            const testMessage = new vscode.TestMessage(message);
                            const lineMatch = message.match(new RegExp(
                                `${path.basename(filePath)}:(\\d+):(\\d+):`
                            ));
                            if (lineMatch) {
                                const line = parseInt(lineMatch[1], 10) - 1;
                                const col = parseInt(lineMatch[2], 10);
                                testMessage.location = new vscode.Location(
                                    test.uri!,
                                    new vscode.Position(line, col)
                                );
                            }
                            run.failed(test, testMessage);
                        } else {
                            run.passed(test);
                        }
                        resolve();
                    }
                );
            });
        } catch (err) {
            const errorMessage = err instanceof Error ? err.message : String(err);
            run.failed(test, new vscode.TestMessage(errorMessage));
        }
    }

    run.end();
}

// ============================================================================
// Extension Deactivation
// ============================================================================

export function deactivate(): void {
    console.log('Zig Visual Tools deactivated.');
}