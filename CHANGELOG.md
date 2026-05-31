# Change Log

All notable changes to the "zig-visual-tools" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.1.0] - 2026-05-31

### Added

- Build Targets tree view listing all `zig build` steps
- Build Artifacts tree view showing executables, static/shared libraries with inline actions
- Source file mapping parsed from `build.zig` (Zig 0.16 `b.createModule` + `mod.addCSourceFiles` syntax)
- Artifact dependency graph visualization
- Test Explorer with automatic `test "name"` discovery and file watching
- Run, Debug (GDB/LLDB), and Rebuild actions on artifacts
- Configurable debugger backend (`zigVisualTools.debugger`: `"gdb"` or `"lldb"`)
- Open source files directly from artifact tree with themed file icons
