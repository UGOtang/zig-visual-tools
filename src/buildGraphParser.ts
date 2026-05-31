/**
 * Parser for extracting source file dependencies and build graph from
 * build.zig and `zig build --summary all` output.
 *
 * Inspired by CMake's visual target dependency graph, this module provides:
 * - Source file extraction for each artifact
 * - Dependency relationships between artifacts
 * - Artifact-to-source-file mapping
 */

import * as path from 'path';
import * as fs from 'fs';
import type {
    BuildArtifact,
    ArtifactSourceFile,
    ArtifactDependency,
    BuildStep,
    BuildSummary,
    BuildGraphContext
} from './types';

// ============================================================================
// build.zig Parser: Extract root source files for each artifact
// ============================================================================

/**
 * Parse build.zig to find root source files associated with each artifact.
 * This scans for patterns like:
 *   b.addExecutable(.{ .name = "myexe", .root_module = ... })
 *   b.addStaticLibrary(.{ .name = "mylib", .root_module = ... })
 *   b.addSharedLibrary(.{ .name = "mylib", .root_module = ... })
 *   b.addObject(.{ .name = "myobj", .root_module = ... })
 *
 * Supports both modern Zig (0.12+) syntax with b.path() and older syntax.
 */
export function parseBuildZig(workspaceRoot: string): Map<string, string[]> {
    const artifactSources = new Map<string, string[]>();
    const buildZigPath = path.join(workspaceRoot, 'build.zig');

    try {
        const content = fs.readFileSync(buildZigPath, 'utf8');
        const lines = content.split('\n');

        // Find all addExecutable / addStaticLibrary / addSharedLibrary / addObject / addTest declarations
        // and their root source files
        let currentArtifact: string | null = null;
        let braceDepth = 0;
        let inArtifactBlock = false;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            // Match modern Zig 0.12+ syntax:
            //   b.addExecutable(.{ .name = "artifact_name", ... })
            //   b.addStaticLibrary(.{ .name = "artifact_name", ... })
            //   b.addSharedLibrary(.{ .name = "artifact_name", ... })
            //   b.addObject(.{ .name = "artifact_name", ... })
            //   b.addTest(.{ .name = "artifact_name", ... })
            // Also support older syntax:
            //   b.addExecutable("name", "src/main.zig")
            const modernMatch = line.match(/\.add(Executable|StaticLibrary|SharedLibrary|Object|Test)\s*\(/);
            const legacyMatch = line.match(/\.add(Executable|Library|Test|Object)\s*\(/);
            const addMatch = modernMatch || legacyMatch;

            if (addMatch) {
                // Check if this is modern syntax (.{ ... }) or legacy syntax
                const isModern = line.includes('.{') || (i + 1 < lines.length && lines[i + 1].includes('.{'));

                if (isModern) {
                    // Look for .name = "..." in the next few lines or same line
                    const blockText = extractBlockText(lines, i);
                    const nameMatch = blockText.match(/\.name\s*=\s*"([^"]+)"/);
                    if (nameMatch) {
                        currentArtifact = nameMatch[1];
                        if (!artifactSources.has(currentArtifact)) {
                            artifactSources.set(currentArtifact, []);
                        }
                        inArtifactBlock = true;
                        braceDepth = 0;
                    }
                } else {
                    // Legacy syntax: b.addExecutable("name", "src/main.zig")
                    const legacyNameMatch = line.match(/\(\s*"([^"]+)"\s*,/);
                    const legacySrcMatch = line.match(/,\s*"([^"]+)"\s*\)/);

                    if (legacyNameMatch) {
                        currentArtifact = legacyNameMatch[1];
                        if (!artifactSources.has(currentArtifact)) {
                            artifactSources.set(currentArtifact, []);
                        }

                        // Legacy syntax often has the source file inline
                        if (legacySrcMatch) {
                            const srcPath = legacySrcMatch[1];
                            const sources = artifactSources.get(currentArtifact);
                            if (sources && !sources.includes(srcPath)) {
                                sources.push(srcPath);
                            }
                        }
                    }
                }
                continue;
            }

            // Track brace depth to know when we exit the artifact configuration block
            if (inArtifactBlock) {
                for (const ch of line) {
                    if (ch === '{') {
                        braceDepth++;
                    }
                    if (ch === '}') {
                        braceDepth--;
                    }
                }

                if (braceDepth <= 0 && line.includes('})')) {
                    inArtifactBlock = false;
                    currentArtifact = null;
                    continue;
                }
            }

            // Match: .root_source_file = b.path("src/main.zig") - modern Zig 0.12+
            if (currentArtifact && line.includes('.root_source_file')) {
                // Try modern b.path() syntax first
                const modernSrcMatch = line.match(/\.root_source_file\s*=\s*(?:b\.path\s*\(\s*"([^"]+)"\s*\)|\.\{\s*\.path\s*=\s*"([^"]+)"\s*\})/);
                if (modernSrcMatch) {
                    const srcPath = modernSrcMatch[1] || modernSrcMatch[2];
                    if (srcPath) {
                        const sources = artifactSources.get(currentArtifact);
                        if (sources && !sources.includes(srcPath)) {
                            sources.push(srcPath);
                        }
                    }
                } else {
                    // Try legacy .root_source_file = "src/main.zig" syntax
                    const legacySrcMatch = line.match(/\.root_source_file\s*=\s*"([^"]+)"/);
                    if (legacySrcMatch) {
                        const srcPath = legacySrcMatch[1];
                        const sources = artifactSources.get(currentArtifact);
                        if (sources && !sources.includes(srcPath)) {
                            sources.push(srcPath);
                        }
                    }
                }
            }

            // Match: .root_module = b.createModule(.{ .root_source_file = ... }) - new module syntax
            if (currentArtifact && line.includes('.root_module')) {
                // Extract the module block and look for root_source_file within
                const moduleBlock = extractBlockText(lines, i);
                const srcMatch = moduleBlock.match(/\.root_source_file\s*=\s*(?:b\.path\s*\(\s*"([^"]+)"\s*\)|"([^"]+)")/);
                if (srcMatch) {
                    const srcPath = srcMatch[1] || srcMatch[2];
                    if (srcPath) {
                        const sources = artifactSources.get(currentArtifact);
                        if (sources && !sources.includes(srcPath)) {
                            sources.push(srcPath);
                        }
                    }
                }
            }

            // Match: mod.addCSourceFile() and mod.addCSourceFiles() - C/C++ source files
            // This can be on a module or directly on the artifact
            if (currentArtifact && (line.includes('.addCSourceFile') || line.includes('.addCSourceFiles'))) {
                // Try to extract file paths from addCSourceFile or addCSourceFiles calls
                // Patterns:
                //   mod.addCSourceFile(b.path("src/foo.c"), &.{"-std=c99"});
                //   mod.addCSourceFile(.{ .file = b.path("src/foo.c"), .flags = &.{"-std=c99"} });
                //   mod.addCSourceFiles(&.{"src/foo.c", "src/bar.c"}, &.{"-std=c99"});

                // Single file: addCSourceFile(b.path("..."))
                const singleFileMatch = line.match(/addCSourceFile\s*\(\s*(?:b\.path\s*\(\s*"([^"]+)"|\.\{\s*\.file\s*=\s*(?:b\.path\s*\(\s*"([^"]+)")|\s*"([^"]+)")/);
                if (singleFileMatch) {
                    const srcPath = singleFileMatch[1] || singleFileMatch[2] || singleFileMatch[3];
                    if (srcPath) {
                        const sources = artifactSources.get(currentArtifact);
                        if (sources && !sources.includes(srcPath)) {
                            sources.push(srcPath);
                        }
                    }
                }

                // Multiple files: addCSourceFiles(&.{"file1.c", "file2.c"})
                const multiFileMatch = line.match(/addCSourceFiles\s*\(\s*&\.\{\s*([^}]+)\}/);
                if (multiFileMatch) {
                    const filesList = multiFileMatch[1];
                    // Extract all quoted strings from the list
                    const fileMatches = filesList.matchAll(/"([^"]+\.c)"/g);
                    const sources = artifactSources.get(currentArtifact);
                    if (sources) {
                        for (const match of fileMatches) {
                            const srcPath = match[1];
                            if (!sources.includes(srcPath)) {
                                sources.push(srcPath);
                            }
                        }
                    }
                }
            }

            // Match: mod.linkLibrary() - for C library dependencies
            if (currentArtifact && line.includes('.linkLibrary')) {
                // This indicates a dependency on a C library
                // The library name might be useful for dependency tracking
                const libMatch = line.match(/\.linkLibrary\s*\(\s*(\w+)\s*\)/);
                if (libMatch) {
                    // Could track external C library dependencies here
                    // libMatch[1] is the variable name of the library
                }
            }

            // Match: @cImport/@cInclude references in the source file detection
            // These are detected at runtime via source file analysis, not in build.zig parsing

            // Reset current artifact when we see certain patterns indicating end of block
            if (currentArtifact && !inArtifactBlock) {
                if (line.match(/^\s*\)\s*;?/) ||
                    line.match(/^\s*\}\s*;?/) ||
                    (line.match(/^\s*const\s/) && !line.includes('='))) {
                    currentArtifact = null;
                }
            }
        }

        return artifactSources;
    } catch (err) {
        // If build.zig can't be read, return empty map
        return artifactSources;
    }
}

/**
 * Extract multi-line block text starting from the given line
 */
function extractBlockText(lines: string[], startIndex: number): string {
    let depth = 0;
    let block = '';
    let inBlock = false;

    for (let i = startIndex; i < Math.min(startIndex + 50, lines.length); i++) {
        const line = lines[i];

        for (const ch of line) {
            if (ch === '(') {
                depth++;
                inBlock = true;
            } else if (ch === ')') {
                depth--;
            }
        }

        block += line + '\n';

        if (inBlock && depth === 0) {
            break;
        }
    }

    return block;
}

// ============================================================================
// Source File Discovery
// ============================================================================

/**
 * Supported source file extensions for Zig projects.
 * Zig projects often mix Zig with C/C++ code via @cImport, @cInclude, or addCSourceFile.
 */
const SOURCE_EXTENSIONS = ['.zig', '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx'];

/**
 * Check if a file is a source file (Zig, C, or C++)
 */
function isSourceFile(fileName: string): boolean {
    const lowerName = fileName.toLowerCase();
    return SOURCE_EXTENSIONS.some(ext => lowerName.endsWith(ext));
}

/**
 * Get the language of a source file
 */
function getSourceLanguage(fileName: string): 'zig' | 'c' | 'cpp' | 'objc' | 'unknown' {
    const lowerName = fileName.toLowerCase();
    if (lowerName.endsWith('.zig')) {
        return 'zig';
    } else if (lowerName.endsWith('.c')) {
        return 'c';
    } else if (lowerName.endsWith('.cpp') || lowerName.endsWith('.cc') || lowerName.endsWith('.cxx')) {
        return 'cpp';
    } else if (lowerName.endsWith('.m') || lowerName.endsWith('.mm')) {
        return 'objc';
    } else {
        return 'unknown';
    }
}

/**
 * Discover all source files (.zig, .c, .cpp, etc.) in the workspace.
 * Excludes zig-cache and zig-out directories.
 */
export function discoverSourceFiles(workspaceRoot: string): string[] {
    const sourceFiles: string[] = [];

    try {
        const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });

        // Check for 'src' directory
        const srcPath = path.join(workspaceRoot, 'src');
        if (fs.existsSync(srcPath)) {
            const stats = fs.statSync(srcPath);
            if (stats.isDirectory()) {
                collectSourceFiles(srcPath, sourceFiles, workspaceRoot);
            }
        }

        // Check for 'include' directory (common for C/C++ headers)
        const includePath = path.join(workspaceRoot, 'include');
        if (fs.existsSync(includePath)) {
            const stats = fs.statSync(includePath);
            if (stats.isDirectory()) {
                collectSourceFiles(includePath, sourceFiles, workspaceRoot);
            }
        }

        // Also check for source files in root
        for (const entry of entries) {
            if (entry.isFile() && isSourceFile(entry.name)) {
                const fullPath = path.join(workspaceRoot, entry.name);
                sourceFiles.push(fullPath);
            }
        }
    } catch {
        // Ignore errors
    }

    return sourceFiles;
}

/**
 * Recursively collect source files (.zig, .c, .cpp, .h, etc.) from a directory
 */
function collectSourceFiles(dirPath: string, result: string[], workspaceRoot: string): void {
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);

            if (entry.isDirectory()) {
                // Skip zig-cache, zig-out, and hidden directories
                if (entry.name === 'zig-cache' || entry.name === 'zig-out' || entry.name.startsWith('.')) {
                    continue;
                }
                // Also skip common C/C++ build directories
                if (entry.name === 'build' || entry.name === 'cmake-build' || entry.name === 'out') {
                    continue;
                }
                collectSourceFiles(fullPath, result, workspaceRoot);
            } else if (entry.isFile() && isSourceFile(entry.name)) {
                result.push(fullPath);
            }
        }
    } catch {
        // Ignore permission errors
    }
}

/**
 * Get the language of a source file based on extension
 */
function getSourceFileLanguage(fileName: string): 'zig' | 'c' | 'cpp' | 'objc' | 'header' | 'unknown' {
    const lowerName = fileName.toLowerCase();
    if (lowerName.endsWith('.zig')) {
        return 'zig';
    } else if (lowerName.endsWith('.c')) {
        return 'c';
    } else if (lowerName.endsWith('.cpp') || lowerName.endsWith('.cc') || lowerName.endsWith('.cxx')) {
        return 'cpp';
    } else if (lowerName.endsWith('.m')) {
        return 'objc';
    } else if (lowerName.endsWith('.h') || lowerName.endsWith('.hpp') || lowerName.endsWith('.hxx')) {
        return 'header';
    } else {
        return 'unknown';
    }
}

/**
 * Get detailed info about a source file
 */
export function getSourceFileInfo(
    absolutePath: string,
    workspaceRoot: string,
    isRootSource: boolean
): ArtifactSourceFile | null {
    try {
        const stats = fs.statSync(absolutePath);
        const relativePath = path.relative(workspaceRoot, absolutePath);
        const name = path.basename(absolutePath);

        // Count lines
        const content = fs.readFileSync(absolutePath, 'utf8');
        const lineCount = content.split('\n').length;

        return {
            name,
            absolutePath,
            relativePath,
            isRootSource,
            isGenerated: false,
            language: getSourceFileLanguage(name),
            lineCount,
            fileSize: stats.size
        };
    } catch {
        return null;
    }
}

// ============================================================================
// Dependency Graph Builder
// ============================================================================

/**
 * Build a full build graph context from the summary and workspace.
 * Enriches all artifacts with source file information and dependency data.
 */
export function buildBuildGraph(
    summary: BuildSummary,
    workspaceRoot: string
): BuildGraphContext {
    // 1. Get root source files from build.zig
    const buildZigSources = parseBuildZig(workspaceRoot);

    // 2. Discover all .zig files in the workspace
    const allSourceFiles = discoverSourceFiles(workspaceRoot);

    // 3. Build mapping from artifact name to its compile step
    const artifactCompileSteps = new Map<string, BuildStep>();
    for (const step of summary.allSteps) {
        if (step.type === 'compile_exe' || step.type === 'compile_lib' || step.type === 'compile_obj') {
            artifactCompileSteps.set(step.name, step);
        }
    }

    // 4. Build dependency graph from the build step tree
    const dependencyGraph = buildDependencyGraph(summary);

    // 5. Enrich each artifact with source file info
    const enrichedArtifacts = summary.artifacts.map(artifact => {
        const enriched = { ...artifact };

        // Get root source files from build.zig
        const rootSources = buildZigSources.get(artifact.name) || [];

        // Collect source files
        const sourceFiles: ArtifactSourceFile[] = [];

        // Add root source files
        for (const rootSrc of rootSources) {
            const fullPath = path.isAbsolute(rootSrc)
                ? rootSrc
                : path.join(workspaceRoot, rootSrc);

            const info = getSourceFileInfo(fullPath, workspaceRoot, true);
            if (info) {
                sourceFiles.push(info);
            }
        }

        // If no root sources found from build.zig, try to find root source
        // from the common patterns: src/{artifact_name}.zig or src/main.zig
        if (rootSources.length === 0) {
            const possibleRoots = [
                path.join(workspaceRoot, 'src', `${artifact.name}.zig`),
                path.join(workspaceRoot, 'src', 'main.zig'),
                path.join(workspaceRoot, 'src', 'root.zig'),
                path.join(workspaceRoot, `${artifact.name}.zig`)
            ];

            for (const possibleRoot of possibleRoots) {
                const info = getSourceFileInfo(possibleRoot, workspaceRoot, true);
                if (info) {
                    sourceFiles.push(info);
                    break;
                }
            }
        }

        // Add other .zig files in src/ as "imported" source files
        for (const srcFile of allSourceFiles) {
            const isAlreadyAdded = sourceFiles.some(
                sf => sf.absolutePath === srcFile
            );
            if (!isAlreadyAdded) {
                const info = getSourceFileInfo(srcFile, workspaceRoot, false);
                if (info) {
                    sourceFiles.push(info);
                }
            }
        }

        // Get dependencies for this artifact
        const deps = dependencyGraph.get(artifact.name) || [];

        // Get file size if artifact exists
        if (enriched.absolutePath) {
            try {
                const stats = fs.statSync(enriched.absolutePath);
                enriched.fileSize = stats.size;
            } catch {
                // File doesn't exist yet
            }
        }

        enriched.sourceFiles = sourceFiles;
        enriched.dependencies = deps;

        return enriched;
    });

    return {
        summary,
        artifacts: enrichedArtifacts,
        artifactCompileSteps,
        dependencyGraph
    };
}

/**
 * Build a dependency graph from the build step tree structure.
 * Maps each artifact name to the list of artifacts it depends on.
 */
export function buildDependencyGraph(summary: BuildSummary): Map<string, ArtifactDependency[]> {
    const graph = new Map<string, ArtifactDependency[]>();

    // Find all compile steps and their dependency tree
    for (const step of summary.allSteps) {
        if (step.type !== 'compile_exe' && step.type !== 'compile_lib' && step.type !== 'compile_obj') {
            continue;
        }

        const deps: ArtifactDependency[] = [];

        // Walk children of the compile step to find dependencies
        collectCompileDependencies(step, deps, step.name, summary.allSteps, new Set<string>());

        // Also check if there's an install step that depends on this compile step,
        // and then check siblings/ancestors for other compile steps
        const parentDeps = findSiblingDependencies(step, summary);
        for (const dep of parentDeps) {
            if (!deps.some(d => d.name === dep.name)) {
                deps.push(dep);
            }
        }

        graph.set(step.name, deps);
    }

    return graph;
}

/**
 * Recursively collect compile-step dependencies from the step tree
 */
function collectCompileDependencies(
    step: BuildStep,
    deps: ArtifactDependency[],
    excludeName: string,
    allSteps: BuildStep[],
    visited: Set<string>
): void {
    if (visited.has(step.id)) {
        return;
    }
    visited.add(step.id);

    for (const child of step.children) {
        if (child.type === 'compile_exe' || child.type === 'compile_lib' || child.type === 'compile_obj') {
            if (child.name !== excludeName) {
                deps.push({
                    name: child.name,
                    kind: child.type === 'compile_exe' ? 'exe' : child.type === 'compile_lib' ? 'lib' : 'obj',
                    isTransitive: false,
                    step: child
                });
            }
        }
        // Recurse into child's children for transitive dependencies
        collectCompileDependencies(child, deps, excludeName, allSteps, visited);
    }
}

/**
 * Find dependencies from sibling compile steps within the same parent
 */
function findSiblingDependencies(
    step: BuildStep,
    summary: BuildSummary
): ArtifactDependency[] {
    const deps: ArtifactDependency[] = [];
    const seen = new Set<string>();

    // Look at the build tree to find artifacts that are installed or used
    // by the same parent step
    if (step.parent) {
        for (const sibling of step.parent.children) {
            if ((sibling.type === 'compile_exe' || sibling.type === 'compile_lib') &&
                sibling.name !== step.name &&
                !seen.has(sibling.name)) {
                seen.add(sibling.name);
                deps.push({
                    name: sibling.name,
                    kind: sibling.type === 'compile_exe' ? 'exe' : 'lib',
                    isTransitive: true,
                    step: sibling
                });
            }
        }
    }

    return deps;
}

// ============================================================================
// File Size Formatting
// ============================================================================

/**
 * Format a file size in bytes to a human-readable string
 */
export function formatFileSize(bytes: number | undefined): string {
    if (bytes === undefined) {
        return '';
    }

    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }

    return `${value.toFixed(1)} ${units[unitIndex]}`;
}

/**
 * Format duration in milliseconds to a human-readable string
 */
export function formatDuration(ms: number | undefined): string {
    if (ms === undefined) {
        return '';
    }

    if (ms < 1000) {
        return `${ms}ms`;
    }

    const seconds = ms / 1000;
    if (seconds < 60) {
        return `${seconds.toFixed(1)}s`;
    }

    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    return `${minutes}m ${remainingSeconds}s`;
}