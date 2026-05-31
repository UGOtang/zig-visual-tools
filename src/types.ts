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
    sourceFiles?: string[];
    /** Whether this is a test executable */
    isTest?: boolean;
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
