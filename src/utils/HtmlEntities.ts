/**
 * mod.io sends names HTML-escaped ("Cargo &amp; Lost Pack Progress"). Turn them back into
 * plain text (no DOM needed, so it also works outside a window).
 */
const NAMED: Record<string, string> = {amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " "};

export function decodeHtmlEntities(text: string): string {
    if (!text || !text.includes("&")) return text;
    return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, code: string) => {
        if (code[0] === "#") {
            const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
            return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
        }
        return NAMED[code.toLowerCase()] ?? whole;
    });
}

/** True when the text still has an escaped character in it */
export function hasHtmlEntities(text: string | undefined | null): boolean {
    return !!text && /&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/i.test(text);
}
