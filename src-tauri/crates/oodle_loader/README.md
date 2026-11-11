# oodle_loader (MINTCAT copy)

Copy of `oodle_loader` from [repak](https://github.com/trumank/repak) (rev `355b5f6`,
MIT OR Apache-2.0, see the license files), used through `[patch]` in `src-tauri/Cargo.toml`.

repak needs Epic's Oodle library to read paks compressed with Oodle (e.g. the Missions HUD
mod). The original downloads it once (hash-checked) and saves it next to the running program.
In an AppImage that folder is read-only, so the save failed and every Oodle-compressed mod
failed to install.

Changed (`fetch_oodle`): the library is looked for next to the program first (a bundled or
hand-placed copy, as before), then in `MINTCAT_OODLE_DIR` or, outside Windows,
`$XDG_DATA_HOME/com.mint.cat/oodle` (`~/.local/share/com.mint.cat/oodle`). A download is saved
to that data folder first, falling back to next to the program. On Windows nothing changes
unless `MINTCAT_OODLE_DIR` is set.
