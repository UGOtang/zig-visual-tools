/**
 * Types for Zig Visual Tools extension
 */

/**
 * Represents a build step from `zig build --summary all`
 */
export interface BuildStep {
    /** Unique identifier for this step */
    id: string;
    /** Display name of the step */
    name: string;
    /** Type of the build step */
    type: BuildStepType;
    /** Current status of the step */
    status: BuildStatus;
    /** Artifact produced by this step (if any) */
    artifact?: BuildArtifact;
    /** Build duration in milliseconds */
    duration?: number;
    /** Memory usage (MaxRSS) in bytes */
    memory?: number;
    /** Child steps (dependencies) */
    children: BuildStep[];
    /** Parent step reference (for navigation) */
    parent?: BuildStep;
    /** Indentation level in the summary output */
    level: number;
    /** Raw line from the build summary */
    rawLine: string;
}

/**
 * Type of build step
 */
export type BuildStepType =
    | 'compile_exe'    // compile exe <name>
    | 'compile_lib'    // compile lib <name>
    | 'compile_obj'    // compile obj <name>
    | 'install'        // install <name>
    | 'writefile'      // WriteFile
    | 'run'            // run artifact
    | 'other';         // Other steps

/**
 * Build status
 */
export type BuildStatus =
    | 'success'
    | 'cached'
    | 'failure'
    | 'running'
    | 'pending';

/**
 * Represents a build artifact (executable, library, or object file)
 */
export interface BuildArtifact {
    /** Name of the artifact */
    name: string;
    /** Kind of artifact */
    kind: 'exe' | 'lib' | 'obj';
    /** Full path to the artifact (relative to workspace) */
    path: string;
    /** Absolute path to the artifact */
    absolutePath?: string;
    /** Build mode */
    optimize?: 'Debug' | 'ReleaseSafe' | 'ReleaseFast' | 'ReleaseSmall';
    /** Target triple (e.g., 'native', 'x86_64-linux') */
    target?: string;
    /** Source files that this artifact depends on */
    sourceFiles?: ArtifactSourceFile[];
    /** Whether this is a test executable */
    isTest?: boolean;
    /** Whether this is a dynamic/shared library (only applicable when kind is 'lib') */
    isDynamic?: boolean;
    /** Link-time dependencies (other artifacts this needs at link time) */
    dependencies?: ArtifactDependency[];
    /** Size of the artifact file in bytes */
    fileSize?: number;
}

/**
 * Information about a source file that belongs to an artifact
 */
export interface ArtifactSourceFile {
    /** File name (e.g. 'main.zig') */
    name: string;
    /** Absolute path to the source file */
    absolutePath: string;
    /** Relative path from workspace root */
    relativePath: string;
    /** Whether this is the root source file of the artifact */
    isRootSource: boolean;
    /** Whether this source file is auto-generated (e.g. in zig-cache) */
    isGenerated: boolean;
    /** Number of lines in the source file */
    lineCount?: number;
    /** File size in bytes */
    fileSize?: number;
    /** Line number of this file reference in build.zig (if found) */
    buildZigLine?: number;
}

/**
 * Represents a dependency relationship between artifacts
 */
export interface ArtifactDependency {
    /** Name of the dependency artifact */
    name: string;
    /** Kind of the dependency */
    kind: 'exe' | 'lib' | 'obj';
    /** Whether this dependency is transitively included */
    isTransitive: boolean;
    /** The build step for this dependency (if available) */
    step?: BuildStep;
}

/**
 * Parsed result from `zig build --summary all`
 */
export interface BuildSummary {
    /** Total number of steps */
    totalSteps: number;
    /** Number of succeeded steps */
    succeededSteps: number;
    /** Whether the build was successful */
    success: boolean;
    /** All build steps in tree structure */
    rootSteps: BuildStep[];
    /** Flattened list of all steps */
    allSteps: BuildStep[];
    /** All artifacts produced */
    artifacts: BuildArtifact[];
    /** Timestamp when the summary was generated */
    timestamp: Date;
}

/**
 * Context for the build graph, containing all parsed information
 */
export interface BuildGraphContext {
    /** Build summary from `zig build --summary all` */
    summary: BuildSummary;
    /** Artifacts with enriched source file information */
    artifacts: BuildArtifact[];
    /** Mapping from artifact name to its compile step */
    artifactCompileSteps: Map<string, BuildStep>;
    /** Mapping from artifact name to its dependencies (other artifacts it links) */
    dependencyGraph: Map<string, ArtifactDependency[]>;
}

/**
 * Tree item for displaying build artifacts
 */
export interface ArtifactTreeNode {
    /** Unique ID for the tree item */
    id: string;
    /** Display label */
    label: string;
    /** Description (shown alongside label) */
    description?: string;
    /** Tooltip text */
    tooltip?: string;
    /** Icon path or ThemeIcon */
    icon?: string;
    /** Context value for menu filtering */
    contextValue: string;
    /** Whether this node is collapsible */
    collapsibleState: 'none' | 'collapsed' | 'expanded';
    /** Children nodes */
    children?: ArtifactTreeNode[];
    /** Associated artifact (if any) */
    artifact?: BuildArtifact;
    /** Associated build step (if any) */
    step?: BuildStep;
    /** Resource URI (for file nodes) */
    resourceUri?: string;
    /** Associated source file (if this node represents a source file) */
    sourceFile?: ArtifactSourceFile;
}

/**
 * Options for running an artifact
 */
export interface RunArtifactOptions {
    /** Run in terminal */
    terminal?: boolean;
    /** Debug mode */
    debug?: boolean;
    /** Additional arguments to pass */
    args?: string[];
    /** Environment variables */
    env?: Record<string, string>;
    /** Working directory */
    cwd?: string;
}