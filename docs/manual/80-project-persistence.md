# Project persistence (v0.7)

Project persistence is implemented in the Electron main process. The renderer receives project IDs, display labels, opaque `rootId` values, and folder status only; it never receives a canonical filesystem path.

## Storage model

- `metadata/projects.json` is an atomic JSON database with `schemaVersion: 2`.
- `config/canonical-roots.json` is a separate atomic JSON store. It contains canonical paths and is written with mode `0600`.
- A project folder is a reference, not an import. Connecting or archiving a project never copies, moves, or deletes log files or artifacts.
- Artifact relations store `sourceId`, `artifactId`, `rootId`, and a POSIX-style relative path. The root path remains main-process-only.

The first empty v1 database is migrated to an empty v2 database during initialization. Existing evaluation recipes continue to use the existing evaluation store and its append-only revision/archive behavior.

## IPC contract

Folder selection is available only through the main-process `project:attach-folder` handler, which opens the native directory dialog. Canonicalization uses `realpath`; validation reports `available`, `missing`, or `permission-denied`. All project mutations require `expectedRevision` and increment the project revision atomically. Stale writes fail with a revision conflict.

Project archive is metadata-only. Export presets can be saved and archived, equipment profiles are stored by alias, and evaluation template pins retain the selected template revision.
