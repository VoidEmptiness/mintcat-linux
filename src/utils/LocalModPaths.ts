/**
 * Turn one clipboard line into a local filesystem path, or null if it isn't one.
 *
 * Accepts:
 *  - absolute paths:            /home/me/mods/Foo.pak, C:\mods\Foo.pak
 *  - quoted paths:              "/home/me/My Mods/Foo.pak", '/home/me/x.zip'
 *  - file URIs (file managers): file:///home/me/My%20Mods/Foo.pak
 *  - home-relative paths:       ~/mods/Foo.pak (needs homeDir)
 */
export function parseLocalPathLine(line: string, homeDir?: string): string | null {
    let value = line.trim();
    if (!value) return null;

    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1).trim();
    }

    if (/^file:\/\//i.test(value)) {
        try {
            const url = new URL(value);
            if (url.protocol !== 'file:') return null;
            let path = decodeURIComponent(url.pathname);
            // file:///C:/x -> C:/x on Windows
            if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
            return path || null;
        } catch {
            return null;
        }
    }

    if (value.startsWith('~/') && homeDir) {
        return homeDir.replace(/[\\/]+$/, '') + value.slice(1);
    }

    if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) {
        return value;
    }

    return null;
}

/** .pak / .zip mod archive by name */
export function isModArchivePath(path: string): boolean {
    return /\.(pak|zip)$/i.test(path);
}

/** Split clipboard / pasted text into non-empty trimmed lines */
export function splitLines(text: string): string[] {
    return text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
}

/** Merge new lines into existing text, keeping order and skipping duplicates */
export function mergeLines(existing: string, added: string): string {
    const result = splitLines(existing);
    for (const line of splitLines(added)) {
        if (!result.includes(line)) result.push(line);
    }
    return result.join('\n');
}
