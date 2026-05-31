import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import type { BuildArtifact, BuildSummary } from './types';
import {
    fetchBuildSummary,
    getExecutables,
    getLibraries,
    artifactExists
} from './buildParser';

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
    // 2. Build Artifacts TreeView
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

    context.subscriptions.push(
        artifactsTreeView,
        refreshArtifactsDisposable,
        runArtifactDisposable,
        debugArtifactDisposable,
        rebuildArtifactDisposable,
        openFolderDisposable
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

function debugArtifact(artifact: BuildArtifact, workspaceRoot: string | undefined) {
    if (!workspaceRoot || !artifact.absolutePath) {
        vscode.window.showErrorMessage('Cannot debug artifact: missing path information.');
        return;
    }

    if (!artifactExists(artifact)) {
        vscode.window.showErrorMessage(`Artifact does not exist: ${artifact.name}. Build it first.`);
        return;
    }

    const terminal = vscode.window.createTerminal({
        name: `Debug: ${artifact.name}`,
        cwd: workspaceRoot
    });
    terminal.show();
    terminal.sendText(`lldb "${artifact.absolutePath}"`);
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
// Build Artifacts Tree Provider
// ============================================================================

class BuildArtifactsProvider implements vscode.TreeDataProvider<ArtifactTreeItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<ArtifactTreeItem | undefined | null | void> =
        new vscode.EventEmitter<ArtifactTreeItem | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<ArtifactTreeItem | undefined | null | void> =
        this._onDidChangeTreeData.event;

    private summary: BuildSummary | null = null;

    constructor(private workspaceRoot: string | undefined) {}

    refresh(): void {
        this.summary = null;
        this._onDidChangeTreeData.fire();
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

        // If we have an element, show its children (dependencies)
        if (element && element.children && element.children.length > 0) {
            return element.children;
        }

        // Load build summary if not cached
        if (!this.summary) {
            try {
                this.summary = await fetchBuildSummary(this.workspaceRoot);
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

            // Executables
            const exes = getExecutables(this.summary);
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

            // Libraries
            const libs = getLibraries(this.summary);
            if (libs.length > 0) {
                const libFolder = new ArtifactTreeItem(
                    'libraries',
                    'Libraries',
                    vscode.TreeItemCollapsibleState.Expanded,
                    'folder',
                    new vscode.ThemeIcon('library')
                );
                libFolder.children = libs.map(artifact => this.createArtifactItem(artifact));
                items.push(libFolder);
            }

            // Summary info
            const info = new ArtifactTreeItem(
                'summary',
                `${this.summary.succeededSteps}/${this.summary.totalSteps} steps`,
                vscode.TreeItemCollapsibleState.None,
                'info',
                new vscode.ThemeIcon('info')
            );
            info.description = this.summary.success ? '✓ Build succeeded' : '✗ Build failed';
            items.push(info);

            return items;
        }

        return [];
    }

    private createArtifactItem(artifact: BuildArtifact): ArtifactTreeItem {
        const exists = artifactExists(artifact);
        const contextValue = artifact.kind === 'exe' ? 'zigArtifactExe' : 'zigArtifactLib';

        const item = new ArtifactTreeItem(
            artifact.name,
            artifact.name,
            vscode.TreeItemCollapsibleState.None,
            contextValue,
            artifact.kind === 'exe'
                ? new vscode.ThemeIcon('play')
                : new vscode.ThemeIcon('file-binary'),
            artifact
        );

        // Add status indicator
        item.description = exists ? '✓' : '✗ Not built';
        item.tooltip = artifact.path;

        if (artifact.optimize) {
            item.description += ` [${artifact.optimize}]`;
        }

        return item;
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
        public readonly artifact?: BuildArtifact
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
