/**
 * Parser for extracting source file dependencies and build graph from
 * build.zig and `zig build --summary all` output.
 *
 * Supports both:
 * - Modern Zig 0.16+ syntax: b.createModule() + b.addLibrary/.addExecutable(.{ .root_module = mod })
 * - Legacy syntax: b.addExecutable(.{ .root_source_file = ... })
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
// build.zig Parser: Extract source files for each artifact
// ============================================================================

/**
 * Represents an artifact's source files extracted from build.zig
 */
interface ArtifactSourceInfo {
    /** Artifact name from .name = "..." or addLibrary/addExecutable */
    name: string;
    /** Root source file (Zig) if any */
    rootSourceFile: string | null;
    /** C/C++ source files from addCSourceFiles */
    cSourceFiles: string[];
    /** Whether this is a test artifact */
    isTest: boolean;
    /** Kind of artifact */
    kind: 'exe' | 'lib' | 'obj';
    /** Whether library is dynamic/shared */
    isDynamic: boolean;
    /** Module variable name (e.g., "leveldb_mod") for tracking addCSourceFiles */
    moduleName: string | null;
}

/**
 * Parse build.zig to find source files associated with each artifact.
 *
 * Strategy:
 * 1. Find all `b.createModule(...)` calls and record their variable names
 * 2. Find all `b.addLibrary/addExecutable/addTest/addObject(...)` calls and
 *    extract .name, .root_module variable, .linkage
 * 3. For each module, find `mod.addCSourceFiles(...)` calls with their file lists
 * 4. For each module, find `.root_source_file = ...`
 * 5. Map modules back to artifacts via .root_module reference
 */
export function parseBuildZig(workspaceRoot: string): Map<string, ArtifactSourceInfo> {
    const result = new Map<string, ArtifactSourceInfo>();
    const buildZigPath = path.join(workspaceRoot, 'build.zig');

    try {
        const content = fs.readFileSync(buildZigPath, 'utf8');

        // Step 1: Find all module variable declarations: const xxx_mod = b.createModule(...)
        const moduleMap = new Map<string, ArtifactSourceInfo>();
        const moduleRegex = /const\s+(\w+)\s*=\s*b\.createModule\s*\(/g;
        let moduleMatch;
        while ((moduleMatch = moduleRegex.exec(content)) !== null) {
            const varName = moduleMatch[1];
            // Extract the block following createModule
            const blockStart = moduleMatch.index;
            const blockText = extractBlockTextFromContent(content, blockStart);

            // Find root_source_file in the module block
            let rootSourceFile: string | null = null;
            const rootSrcMatch = blockText.match(/\.root_source_file\s*=\s*(?:b\.path\s*\(\s*"([^"]+)"\s*\)|"([^"]+)")/);
            if (rootSrcMatch) {
                rootSourceFile = rootSrcMatch[1] || rootSrcMatch[2] || null;
            }

            const info: ArtifactSourceInfo = {
                name: varName,
                rootSourceFile,
                cSourceFiles: [],
                isTest: false,
                kind: 'lib', // default, will be updated when linked
                isDynamic: false,
                moduleName: varName
            };
            moduleMap.set(varName, info);
        }

        // Step 2: Find addCSourceFiles calls on module variables
        // Pattern: mod_name.addCSourceFiles(.{ .root = ..., .files = &.{...} })
        for (const [varName, info] of moduleMap) {
            // Find all addCSourceFiles calls for this module variable
            const cSrcRegex = new RegExp(
                `${escapeRegex(varName)}\\.addCSourceFiles\\s*\\(`,
                'g'
            );
            let cSrcMatch;
            while ((cSrcMatch = cSrcRegex.exec(content)) !== null) {
                const blockText = extractBlockTextFromContent(content, cSrcMatch.index);
                const files = extractCSourceFilesFromBlock(blockText);
                info.cSourceFiles.push(...files);
            }

            // Also check for addCSourceFile (singular)
            const cSrcSingleRegex = new RegExp(
                `${escapeRegex(varName)}\\.addCSourceFile\\s*\\(`,
                'g'
            );
            let cSrcSingleMatch;
            while ((cSrcSingleMatch = cSrcSingleRegex.exec(content)) !== null) {
                const blockText = extractBlockTextFromContent(content, cSrcSingleMatch.index);
                const files = extractCSourceFilesFromBlock(blockText);
                info.cSourceFiles.push(...files);
            }
        }

        // Step 3: Find all addLibrary/addExecutable/addTest calls
        // Pattern: b.addLibrary(.{ .name = "xxx", .root_module = var_name })
        // Pattern: b.addExecutable(.{ .name = "xxx", .root_module = var_name })
        const artifactRegex = /b\.add(Executable|Library|Test|Object)\s*\(/g;
        let artifactMatch;
        while ((artifactMatch = artifactRegex.exec(content)) !== null) {
            const kindStr = artifactMatch[1];
            const blockText = extractBlockTextFromContent(content, artifactMatch.index);

            // Extract name
            const nameMatch = blockText.match(/\.name\s*=\s*"([^"]+)"/);
            if (!nameMatch) {
                continue;
            }
            const artifactName = nameMatch[1];

            // Extract root_module reference
            const rootModuleMatch = blockText.match(/\.root_module\s*=\s*(\w+)/);

            // Extract linkage
            const linkageMatch = blockText.match(/\.linkage\s*=\s*\.(\w+)/);
            const isDynamic = linkageMatch?.[1] === 'dynamic';

            // Determine kind
            let kind: 'exe' | 'lib' | 'obj' = 'lib';
            if (kindStr === 'Executable') {
                kind = 'exe';
            } else if (kindStr === 'Object') {
                kind = 'obj';
            }

            // Check for test
            const isTest = kindStr === 'Test';

            // Check for root_source_file directly in the artifact block (non-module syntax)
            let rootSourceFile: string | null = null;
            const rootSrcMatch = blockText.match(/\.root_source_file\s*=\s*(?:b\.path\s*\(\s*"([^"]+)"\s*\)|"([^"]+)")/);
            if (rootSrcMatch) {
                rootSourceFile = rootSrcMatch[1] || rootSrcMatch[2] || null;
            }

            // Build the artifact info
            const info: ArtifactSourceInfo = {
                name: artifactName,
                rootSourceFile,
                cSourceFiles: [],
                isTest,
                kind,
                isDynamic,
                moduleName: null
            };

            // If there's a root_module reference, merge the module's source files
            if (rootModuleMatch) {
                const moduleVarName = rootModuleMatch[1];
                info.moduleName = moduleVarName;
                const moduleInfo = moduleMap.get(moduleVarName);
                if (moduleInfo) {
                    info.cSourceFiles = [...moduleInfo.cSourceFiles];
                    if (!info.rootSourceFile && moduleInfo.rootSourceFile) {
                        info.rootSourceFile = moduleInfo.rootSourceFile;
                    }
                }
            }

            // Also look for addCSourceFiles directly on the artifact variable
            // This handles patterns like:
            //   const exe = b.addExecutable(.{...});
            //   exe.addCSourceFiles(.{...});
            // We need to find the variable name first
            const varDeclMatch = content.substring(0, artifactMatch.index).match(/const\s+(\w+)\s*=\s*$/m);
            if (varDeclMatch) {
                const artifactVarName = varDeclMatch[1];
                const cSrcRegex = new RegExp(
                    `${escapeRegex(artifactVarName)}\\.addCSourceFiles\\s*\\(`,
                    'g'
                );
                let cSrcMatchInner;
                while ((cSrcMatchInner = cSrcRegex.exec(content)) !== null) {
                    const innerBlockText = extractBlockTextFromContent(content, cSrcMatchInner.index);
                    const files = extractCSourceFilesFromBlock(innerBlockText);
                    info.cSourceFiles.push(...files);
                }
            }

            result.set(artifactName, info);
        }

        // Step 4: Also find artifacts declared with legacy syntax
        // Pattern: const xxx = b.addStaticLibrary(.{ .name = "xxx", ... })
        // or: const xxx = b.addSharedLibrary(.{ .name = "xxx", ... })
        const legacyArtifactRegex = /b\.add(StaticLibrary|SharedLibrary)\s*\(/g;
        let legacyMatch;
        while ((legacyMatch = legacyArtifactRegex.exec(content)) !== null) {
            const kindStr = legacyMatch[1];
            const blockText = extractBlockTextFromContent(content, legacyMatch.index);

            const nameMatch = blockText.match(/\.name\s*=\s*"([^"]+)"/);
            if (!nameMatch) {
                continue;
            }
            const artifactName = nameMatch[1];

            // Skip if already found
            if (result.has(artifactName)) {
                continue;
            }

            const isDynamic = kindStr === 'SharedLibrary';

            const info: ArtifactSourceInfo = {
                name: artifactName,
                rootSourceFile: null,
                cSourceFiles: [],
                isTest: false,
                kind: 'lib',
                isDynamic,
                moduleName: null
            };

            // Check for root_module reference
            const rootModuleMatch = blockText.match(/\.root_module\s*=\s*(\w+)/);
            if (rootModuleMatch) {
                const moduleVarName = rootModuleMatch[1];
                info.moduleName = moduleVarName;
                const moduleInfo = moduleMap.get(moduleVarName);
                if (moduleInfo) {
                    info.cSourceFiles = [...moduleInfo.cSourceFiles];
                    if (moduleInfo.rootSourceFile) {
                        info.rootSourceFile = moduleInfo.rootSourceFile;
                    }
                }
            }

            // Check for root_source_file directly
            const rootSrcMatch = blockText.match(/\.root_source_file\s*=\s*(?:b\.path\s*\(\s*"([^"]+)"\s*\)|"([^"]+)")/);
            if (rootSrcMatch) {
                info.rootSourceFile = rootSrcMatch[1] || rootSrcMatch[2] || null;
            }

            result.set(artifactName, info);
        }

        return result;
    } catch {
        return result;
    }
}

/**
 * Extract C source file paths from a block of text (addCSourceFiles call)
 */
function extractCSourceFilesFromBlock(blockText: string): string[] {
    const files: string[] = [];

    // Pattern: .files = &.{ "file1", "file2", ... }
    const filesListMatch = blockText.match(/\.files\s*=\s*&\.\{([^}]+)\}/s);
    if (filesListMatch) {
        const filesList = filesListMatch[1];
        const fileMatches = filesList.matchAll(/"([^"]+)"/g);
        for (const match of fileMatches) {
            const filePath = match[1];
            // Only include actual source files (not flags)
            if (isSourceFilePath(filePath)) {
                files.push(filePath);
            }
        }
    }

    // Legacy pattern: addCSourceFiles(&.{ "file1", "file2" }, &.{})
    if (files.length === 0) {
        const legacyMatch = blockText.match(/addCSourceFiles\s*\(\s*&\.\{([^}]+)\}/s);
        if (legacyMatch) {
            const filesList = legacyMatch[1];
            const fileMatches = filesList.matchAll(/"([^"]+)"/g);
            for (const match of fileMatches) {
                const filePath = match[1];
                if (isSourceFilePath(filePath)) {
                    files.push(filePath);
                }
            }
        }
    }

    // Single file pattern: addCSourceFile(b.path("file"))
    if (files.length === 0) {
        const singleMatch = blockText.match(/addCSourceFile\s*\(\s*(?:b\.path\s*\(\s*"([^"]+)"\s*\)|"([^"]+)")/);
        if (singleMatch) {
            const filePath = singleMatch[1] || singleMatch[2];
            if (filePath && isSourceFilePath(filePath)) {
                files.push(filePath);
            }
        }
    }

    return files;
}

/**
 * Check if a path looks like a source file (not a flag or directory)
 */
function isSourceFilePath(p: string): boolean {
    // Must contain a file extension
    const ext = path.extname(p);
    if (!ext) {
        return false;
    }
    // Must be a known source file extension
    const sourceExts = ['.zig', '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx', '.m', '.mm', '.rc'];
    return sourceExts.includes(ext.toLowerCase());
}

/**
 * Extract block text from content starting at a given index.
 * Handles nested braces and parentheses.
 */
function extractBlockTextFromContent(content: string, startIndex: number): string {
    let depth = 0;
    let block = '';
    let inBlock = false;

    for (let i = startIndex; i < Math.min(startIndex + 5000, content.length); i++) {
        const ch = content[i];

        if (ch === '(' || ch === '.') {
            // Don't count . as depth, but ( does
            if (ch === '(') {
                depth++;
                inBlock = true;
            }
        } else if (ch === ')') {
            depth--;
        }

        block += ch;

        if (inBlock && depth === 0) {
            break;
        }
    }

    return block;
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================================
// Source File Info Builder
// ============================================================================

const SOURCE_EXTENSIONS = ['.zig', '.c', '.cpp', '.cc', '.cxx', '.h', '.hpp', '.hxx'];

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
        let lineCount: number | undefined;
        try {
            const content = fs.readFileSync(absolutePath, 'utf8');
            lineCount = content.split('\n').length;
        } catch {
            // Binary file or unreadable
        }

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
    // 1. Parse build.zig to get source file mappings
    const buildZigSources = parseBuildZig(workspaceRoot);

    // 2. Build mapping from artifact name to its compile step
    const artifactCompileSteps = new Map<string, BuildStep>();
    for (const step of summary.allSteps) {
        if (step.type === 'compile_exe' || step.type === 'compile_lib' || step.type === 'compile_obj') {
            artifactCompileSteps.set(step.name, step);
        }
    }

    // 3. Build dependency graph from the build step tree
    const dependencyGraph = buildDependencyGraph(summary);

    // 4. Enrich each artifact with source file info
    const enrichedArtifacts = summary.artifacts.map(artifact => {
        const enriched = { ...artifact };

        // Get source info from build.zig parsing
        const sourceInfo = buildZigSources.get(artifact.name);
        const sourceFiles: ArtifactSourceFile[] = [];

        if (sourceInfo) {
            // Add root source file (Zig)
            if (sourceInfo.rootSourceFile) {
                const fullPath = path.isAbsolute(sourceInfo.rootSourceFile)
                    ? sourceInfo.rootSourceFile
                    : path.join(workspaceRoot, sourceInfo.rootSourceFile);
                const info = getSourceFileInfo(fullPath, workspaceRoot, true);
                if (info) {
                    sourceFiles.push(info);
                }
            }

            // Add C/C++ source files from addCSourceFiles
            const rootPath = path.join(workspaceRoot, '.');
            for (const srcPath of sourceInfo.cSourceFiles) {
                const fullPath = path.isAbsolute(srcPath)
                    ? srcPath
                    : path.join(rootPath, srcPath);
                const info = getSourceFileInfo(fullPath, workspaceRoot, false);
                if (info) {
                    sourceFiles.push(info);
                }
            }

            // Set isDynamic from build.zig analysis
            if (sourceInfo.isDynamic !== undefined) {
                enriched.isDynamic = sourceInfo.isDynamic;
            }

            // Set isTest from build.zig analysis
            if (sourceInfo.isTest) {
                enriched.isTest = true;
            }
        } else {
            // Fallback: try to find root source file using common patterns
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

    for (const step of summary.allSteps) {
        if (step.type !== 'compile_exe' && step.type !== 'compile_lib' && step.type !== 'compile_obj') {
            continue;
        }

        const deps: ArtifactDependency[] = [];

        // Walk children of the compile step to find dependencies
        collectCompileDependencies(step, deps, step.name, new Set<string>());

        // Also check sibling compile steps
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
        collectCompileDependencies(child, deps, excludeName, visited);
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
// File Size & Duration Formatting
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
