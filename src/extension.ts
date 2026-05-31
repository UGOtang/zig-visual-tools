import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

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
    // 2. Test Controller (Test Explorer)
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
    // Match patterns: test "name" { or test "name" {
    // Also match: test name { for identifier-only names
    const testRegex = /test\s+(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*))\s*\{/g;
    let match;

    const fileUri = vscode.Uri.file(filePath);

    while ((match = testRegex.exec(content)) !== null) {
        const testName = match[1] || match[2];
        if (!testName) {
            continue;
        }

        // Create unique ID: relative path from workspace + test name
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

        // Build test command
        // For tests with quoted names: zig test file.zig --test-filter "test name"
        const testName = test.label;
        const cmd = `zig test "${filePath}" --test-filter "${testName}"`;

        try {
            await new Promise<void>((resolve) => {
                cp.exec(
                    cmd,
                    {
                        cwd: workspaceRoot,
                        timeout: 60000,
                        maxBuffer: 1024 * 1024 * 10 // 10MB buffer
                    },
                    (error: cp.ExecException | null, stdout: string, stderr: string) => {
                        if (token.isCancellationRequested) {
                            run.skipped(test);
                        } else if (error) {
                            // Test failed
                            const message = stderr || stdout || error.message;
                            const testMessage = new vscode.TestMessage(message);
                            // Try to extract line number from error output
                            const lineMatch = message.match(new RegExp(
                                `${path.basename(filePath)}:(\\d+):(\\d+):`
                            ));
                            if (lineMatch) {
                                const line = parseInt(lineMatch[1], 10) - 1; // Convert to 0-indexed
                                const col = parseInt(lineMatch[2], 10);
                                testMessage.location = new vscode.Location(
                                    test.uri!,
                                    new vscode.Position(line, col)
                                );
                            }
                            run.failed(test, testMessage);
                        } else {
                            // Test passed
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
