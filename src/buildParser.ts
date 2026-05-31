/**
 * Parser for `zig build --summary all` output
 */

import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import type { BuildStep, BuildStepType, BuildStatus, BuildArtifact, BuildSummary } from './types';

/**
 * Parse the output of `zig build --summary all`
 */
export function parseBuildSummary(output: string, workspaceRoot: string): BuildSummary {
    const lines = output.split('\n');
    const rootSteps: BuildStep[] = [];
    const allSteps: BuildStep[] = [];
    const artifacts: BuildArtifact[] = [];

    // Parse header: "Build Summary: 25/25 steps succeeded"
    const headerMatch = lines[0]?.match(/Build Summary: (\d+)\/(\d+) steps (succeeded|failed)/);
    const totalSteps = headerMatch ? parseInt(headerMatch[2], 10) : 0;
    const succeededSteps = headerMatch ? parseInt(headerMatch[1], 10) : 0;
    const success = headerMatch?.[3] === 'succeeded';

    // Parse each line
    const stepStack: BuildStep[] = [];

    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.trim() === '') {
            continue;
        }

        const step = parseLine(line, workspaceRoot);
        if (!step) {
            continue;
        }

        // Determine parent based on indentation
        while (stepStack.length > 0 && stepStack[stepStack.length - 1].level >= step.level) {
            stepStack.pop();
        }

        if (stepStack.length > 0) {
            const parent = stepStack[stepStack.length - 1];
            step.parent = parent;
            parent.children.push(step);
        } else {
            rootSteps.push(step);
        }

        stepStack.push(step);
        allSteps.push(step);

        // Extract artifacts
        if (step.artifact) {
            artifacts.push(step.artifact);
        }
    }

    return {
        totalSteps,
        succeededSteps,
        success,
        rootSteps,
        allSteps,
        artifacts,
        timestamp: new Date()
    };
}

/**
 * Parse a single line from the build summary
 */
function parseLine(line: string, workspaceRoot: string): BuildStep | null {
    // Calculate indentation level.
    // Zig 0.16 uses: "   +- " (3 spaces + "+- ") for child steps.
    // Older Zig uses: "|  " or "+- " prefixes.
    // The format looks like:
    //   install cached                                    <- level 0, no indent
    //   +- install zigtmp cached                          <- level 1, "+-" prefix
    //      +- compile exe zigtmp Debug native cached ...   <- level 2, "   +-" prefix

    let contentStart = 0;
    let level = 0;

    // Check for "+-" prefix first (indented or not)
    // "   +- ..." -> spaces followed by "+-"
    const indentMatch = line.match(/^(\s*)\+\-\s*/);
    if (indentMatch) {
        // Level is determined by leading spaces (each level = 3 spaces)
        const spaces = indentMatch[1];
        level = Math.max(1, Math.floor(spaces.length / 3) + 1);
        contentStart = indentMatch[0].length;
    } else {
        // Check for other indent markers: "|  " style
        const pipeMatch = line.match(/^([\s|]+)\-?\s*/);
        if (pipeMatch && pipeMatch[1].includes('|')) {
            level = Math.floor(pipeMatch[1].length / 3);
            contentStart = pipeMatch[0].length;
        } else {
            // Level 0: no indent. Just consume the content as-is.
            // But also check for plain spaces-based indent (older format)
            const spaceMatch = line.match(/^(\s+)/);
            if (spaceMatch) {
                level = Math.floor(spaceMatch[1].length / 3);
                contentStart = spaceMatch[0].length;
            }
            // else contentStart stays 0 (level 0)
        }
    }

    const content = line.slice(contentStart).trim();

    if (!content) {
        return null;
    }

    // Parse the content
    const parsed = parseStepContent(content, workspaceRoot);
    if (!parsed) {
        return null;
    }

    return {
        id: generateStepId(parsed.name, level),
        name: parsed.name,
        type: parsed.type,
        status: parsed.status,
        artifact: parsed.artifact,
        duration: parsed.duration,
        memory: parsed.memory,
        children: [],
        level,
        rawLine: line
    };
}

/**
 * Parse the content of a step line
 */
function parseStepContent(content: string, workspaceRoot: string): {
    name: string;
    type: BuildStepType;
    status: BuildStatus;
    artifact?: BuildArtifact;
    duration?: number;
    memory?: number;
} | null {
    // Check for reused marker
    if (content.includes('(reused)') || content.includes('more reused dependencies')) {
        // This is a reused dependency reference, skip or mark as cached
        const baseName = content.split('(')[0]?.trim();
        if (baseName) {
            return {
                name: baseName,
                type: 'other',
                status: 'cached'
            };
        }
        return null;
    }

    // Parse status from end of line
    let status: BuildStatus = 'success';
    let remaining = content;

    if (remaining.endsWith(' cached')) {
        status = 'cached';
        remaining = remaining.slice(0, -7);
    } else if (remaining.endsWith(' success')) {
        status = 'success';
        remaining = remaining.slice(0, -8);
    } else if (remaining.endsWith(' failure')) {
        status = 'failure';
        remaining = remaining.slice(0, -8);
    }

    // Parse duration and memory
    let duration: number | undefined;
    let memory: number | undefined;

    const durationMatch = remaining.match(/(\d+)ms/);
    if (durationMatch) {
        duration = parseInt(durationMatch[1], 10);
        remaining = remaining.replace(/\d+ms/, '').trim();
    }

    const memoryMatch = remaining.match(/MaxRSS:(\d+)M/);
    if (memoryMatch) {
        memory = parseInt(memoryMatch[1], 10) * 1024 * 1024;  // Convert to bytes
        remaining = remaining.replace(/MaxRSS:\d+M/, '').trim();
    }

    // Parse step type
    if (remaining.startsWith('compile exe ')) {
        const name = remaining.slice('compile exe '.length).trim();
        const parts = name.split(/\s+/);
        const artifactName = parts[0] || name;
        const optimize = parts[1] as 'Debug' | 'ReleaseSafe' | 'ReleaseFast' | 'ReleaseSmall' | undefined;
        const target = parts[2];

        const artifactPath = path.join(workspaceRoot, 'zig-out', 'bin', artifactName);

        return {
            name: artifactName,
            type: 'compile_exe',
            status,
            artifact: {
                name: artifactName,
                kind: 'exe',
                path: `zig-out/bin/${artifactName}`,
                absolutePath: artifactPath,
                optimize: optimize === 'Debug' || optimize === 'ReleaseSafe' || optimize === 'ReleaseFast' || optimize === 'ReleaseSmall' ? optimize : undefined,
                target
            },
            duration,
            memory
        };
    }

    if (remaining.startsWith('compile lib ')) {
        const name = remaining.slice('compile lib '.length).trim();
        const parts = name.split(/\s+/);
        const artifactName = parts[0] || name;
        const optimize = parts[1] as 'Debug' | 'ReleaseSafe' | 'ReleaseFast' | 'ReleaseSmall' | undefined;
        const target = parts[2];

        // Libraries can be static (.a) or shared (.so/.dylib/.dll)
        // Check all possible library paths
        const libPaths = [
            { path: path.join(workspaceRoot, 'zig-out', 'lib', `lib${artifactName}.a`), name: `lib${artifactName}.a`, kind: 'lib' as const },
            { path: path.join(workspaceRoot, 'zig-out', 'lib', `lib${artifactName}.so`), name: `lib${artifactName}.so`, kind: 'lib' as const },
            { path: path.join(workspaceRoot, 'zig-out', 'lib', `lib${artifactName}.dylib`), name: `lib${artifactName}.dylib`, kind: 'lib' as const },
            { path: path.join(workspaceRoot, 'zig-out', 'lib', `${artifactName}.dll`), name: `${artifactName}.dll`, kind: 'lib' as const },
            { path: path.join(workspaceRoot, 'zig-out', 'lib', `${artifactName}.lib`), name: `${artifactName}.lib`, kind: 'lib' as const },
            { path: path.join(workspaceRoot, 'zig-cache', 'lib', `lib${artifactName}.a`), name: `lib${artifactName}.a`, kind: 'lib' as const },
        ];

        let artifactPath = libPaths[0].path;  // Default to static lib path
        let artifactFileName = libPaths[0].name;
        let isDynamic = false;

        // Find the actual existing library file
        for (const lib of libPaths) {
            if (fs.existsSync(lib.path)) {
                artifactPath = lib.path;
                artifactFileName = lib.name;
                isDynamic = lib.name.endsWith('.so') || lib.name.endsWith('.dylib') || lib.name.endsWith('.dll');
                break;
            }
        }

        return {
            name: artifactName,
            type: 'compile_lib',
            status,
            artifact: {
                name: artifactName,
                kind: 'lib',
                path: `zig-out/lib/${artifactFileName}`,
                absolutePath: artifactPath,
                optimize: optimize === 'Debug' || optimize === 'ReleaseSafe' || optimize === 'ReleaseFast' || optimize === 'ReleaseSmall' ? optimize : undefined,
                target,
                // Mark if this is a dynamic/shared library
                isDynamic: isDynamic  // Mark if this is a dynamic/shared library
            },
            duration,
            memory
        };
    }

    if (remaining.startsWith('compile obj ')) {
        const name = remaining.slice('compile obj '.length).trim();
        const parts = name.split(/\s+/);
        const artifactName = parts[0] || name;
        const optimize = parts[1] as 'Debug' | 'ReleaseSafe' | 'ReleaseFast' | 'ReleaseSmall' | undefined;
        const target = parts[2];

        // Object files are typically in zig-out/obj/ or zig-cache/
        const objPaths = [
            { path: path.join(workspaceRoot, 'zig-out', 'obj', `${artifactName}.o`), name: `${artifactName}.o` },
            { path: path.join(workspaceRoot, 'zig-out', 'obj', `${artifactName}.obj`), name: `${artifactName}.obj` },
            { path: path.join(workspaceRoot, 'zig-cache', 'obj', `${artifactName}.o`), name: `${artifactName}.o` },
            { path: path.join(workspaceRoot, 'zig-cache', `${artifactName}.o`), name: `${artifactName}.o` },
        ];

        let artifactPath = objPaths[0].path;
        let artifactFileName = objPaths[0].name;

        // Find the actual existing object file
        for (const obj of objPaths) {
            if (fs.existsSync(obj.path)) {
                artifactPath = obj.path;
                artifactFileName = obj.name;
                break;
            }
        }

        return {
            name: artifactName,
            type: 'compile_obj',
            status,
            artifact: {
                name: artifactName,
                kind: 'obj',
                path: `zig-out/obj/${artifactFileName}`,
                absolutePath: artifactPath,
                optimize: optimize === 'Debug' || optimize === 'ReleaseSafe' || optimize === 'ReleaseFast' || optimize === 'ReleaseSmall' ? optimize : undefined,
                target
            },
            duration,
            memory
        };
    }

    if (remaining.startsWith('install ')) {
        const name = remaining.slice('install '.length).trim();

        // install step in build.zig copies artifact to zig-out/
        // Try to determine what kind of artifact is being installed
        let installPath: string | undefined;
        let installedArtifact: BuildArtifact | undefined;

        // Check common install locations based on artifact type inference
        // Executables go to zig-out/bin/
        // Libraries go to zig-out/lib/
        // Headers go to zig-out/include/

        // Try executable path first
        const exePath = path.join(workspaceRoot, 'zig-out', 'bin', name);
        if (fs.existsSync(exePath)) {
            installPath = `zig-out/bin/${name}`;
            installedArtifact = {
                name,
                kind: 'exe',
                path: installPath,
                absolutePath: exePath
            };
        } else {
            // Try library paths (static and dynamic)
            const libNames = [
                `lib${name}.a`,                    // Static library (Unix)
                `lib${name}.so`,                   // Shared library (Linux)
                `lib${name}.dylib`,                // Shared library (macOS)
                `${name}.dll`,                     // Shared library (Windows)
                `${name}.lib`,                     // Static library (Windows)
                `${name}.a`,                       // Static library (bare name)
            ];

            for (const libName of libNames) {
                const libPath = path.join(workspaceRoot, 'zig-out', 'lib', libName);
                if (fs.existsSync(libPath)) {
                    installPath = `zig-out/lib/${libName}`;
                    const isDynamic = libName.endsWith('.so') || libName.endsWith('.dylib') || libName.endsWith('.dll');
                    installedArtifact = {
                        name,
                        kind: 'lib',
                        path: installPath,
                        absolutePath: libPath,
                        isDynamic: isDynamic
                    };
                    break;
                }
            }
        }

        return {
            name,
            type: 'install',
            status,
            artifact: installedArtifact
        };
    }

    if (remaining.startsWith('WriteFile')) {
        const name = remaining.slice('WriteFile '.length).trim() || 'WriteFile';

        return {
            name,
            type: 'writefile',
            status
        };
    }

    // Generic step
    return {
        name: remaining,
        type: 'other',
        status
    };
}

/**
 * Generate a unique ID for a step
 */
function generateStepId(name: string, level: number): string {
    return `step_${level}_${name.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

/**
 * Run `zig build --summary all` and parse the result
 */
export async function fetchBuildSummary(workspaceRoot: string): Promise<BuildSummary> {
    return new Promise((resolve, reject) => {
        // Zig outputs build summary to stderr. We must merge both streams,
        // but prefer stderr content since that's where the summary goes.
        cp.exec(
            'zig build --summary all 2>&1',
            {
                cwd: workspaceRoot,
                timeout: 120000,  // 2 minutes timeout
                maxBuffer: 1024 * 1024 * 50  // 50MB buffer
            },
            (error: cp.ExecException | null, stdout: string, stderr: string) => {
                // With 2>&1, everything comes through stdout. Fallback to stderr.
                let output = stdout || stderr || '';

                // Filter out progress indicator lines (lines starting with [ or q or x)
                // these are terminal control sequences that pollute the summary
                const relevantLines: string[] = [];
                for (const line of output.split('\n')) {
                    if (line.startsWith('[') || line.startsWith('q ') || line.startsWith('x ') || line.startsWith('   q ') || line.startsWith('   x ')) {
                        continue;
                    }
                    relevantLines.push(line);
                }
                output = relevantLines.join('\n');

                if (!output) {
                    reject(error || new Error('No output from zig build'));
                    return;
                }

                try {
                    const summary = parseBuildSummary(output, workspaceRoot);
                    resolve(summary);
                } catch (parseError) {
                    reject(parseError);
                }
            }
        );
    });
}

/**
 * Get the list of executables from the build summary
 */
export function getExecutables(summary: BuildSummary): BuildArtifact[] {
    return summary.artifacts.filter(a => a.kind === 'exe');
}

/**
 * Get the list of libraries from the build summary
 */
export function getLibraries(summary: BuildSummary): BuildArtifact[] {
    return summary.artifacts.filter(a => a.kind === 'lib');
}

/**
 * Check if an artifact file exists
 */
export function artifactExists(artifact: BuildArtifact): boolean {
    if (!artifact.absolutePath) {
        return false;
    }
    try {
        fs.accessSync(artifact.absolutePath, fs.constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

/**
 * Get dependencies for a specific step
 */
export function getStepDependencies(step: BuildStep): BuildStep[] {
    const dependencies: BuildStep[] = [];

    function collectDeps(current: BuildStep) {
        for (const child of current.children) {
            if (child.type === 'compile_exe' || child.type === 'compile_lib') {
                dependencies.push(child);
            }
            collectDeps(child);
        }
    }

    collectDeps(step);
    return dependencies;
}
