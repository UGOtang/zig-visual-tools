# Zig Visual Tools

Visualize Zig build steps, artifacts, and tests directly in VS Code.

## Features

### Build Targets

View all available `zig build` steps in a sidebar tree. Click the play button to run any step in a terminal.

### Build Artifacts

After building, browse all compiled artifacts — executables, static/shared libraries — organized by type. Each artifact shows:

- **Source Files**: All `.zig`, `.c`, `.cpp`, `.h` files used to build it (parsed from `build.zig`)
- **Dependencies**: Other artifacts it links against
- **Details**: Build mode, target, file size

Inline actions on each artifact:

| Action | Description |
|--------|-------------|
| ▶ Run | Execute the artifact in a terminal |
| 🐛 Debug | Launch a full debug session with breakpoints (GDB or LLDB) |
| 🔄 Rebuild | Rebuild just this artifact |
| 📁 Open in Explorer | Reveal the artifact file in your OS file manager |

### Test Explorer

Automatically discovers `test "name"` declarations across all `.zig` files in your workspace. Run individual tests or all at once with native VS Code test UI.

### Build Dependency Graph

Use the graph icon in the Build Artifacts panel header to generate a text-based dependency visualization showing the full artifact tree with source files and dependency chains.

## Requirements

- **Zig** ≥ 0.11 (tested with 0.16)
- **GDB** (default debugger) — requires [C/C++ extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode.cpptools)
- **LLDB** (optional) — requires [CodeLLDB extension](https://marketplace.visualstudio.com/items?itemName=vadimcn.vscode-lldb)

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `zigVisualTools.debugger` | `"gdb"` | Debugger backend: `"gdb"` (via C/C++ extension) or `"lldb"` (via CodeLLDB) |

## Usage

1. Open a Zig project containing `build.zig`
2. Click the Zig icon in the Activity Bar
3. **Build Targets** panel lists all steps from `zig build --help`
4. Run `zig build` once, then **Build Artifacts** populates with compiled outputs
5. Expand any artifact to see its source files and dependencies
6. Click source files to open them in the editor
7. Use ▶ / 🐛 / 🔄 buttons on executables to run, debug, or rebuild

## Known Issues

- Source file mapping relies on parsing `build.zig` text; complex or unconventional build configurations may not be fully captured
- `zig build uninstall` is not supported on Zig 0.16 (upstream TODO)

## Release Notes

### 0.1.0

Initial release:

- Build Targets tree view from `zig build --help`
- Build Artifacts tree view from `zig build --summary all`
- Source file mapping parsed from `build.zig` (supports Zig 0.16 module syntax)
- Artifact dependency graph visualization
- Test Explorer with file watching
- Run / Debug / Rebuild actions on artifacts
- Configurable debugger backend (GDB / LLDB)
