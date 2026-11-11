/**
 * The pictures in the title bar: the app icon next to the name (normally the MINTCAT cat) and
 * the profile picture on the right. Each can be one of the built-in icons or any image file
 * the user picks; the image is scaled down to 128 px and kept in the settings table, so it
 * still works if the original file is moved.
 */
import {readFile} from "@tauri-apps/plugin-fs";
import {StorageAPI} from "@/storage";

export type LookTarget = "logo" | "avatar";

export type IconChoice =
    | { kind: "builtin"; id: string }
    | { kind: "image"; dataUrl: string; name?: string };

interface LookData {
    logo?: IconChoice;
    avatar?: IconChoice;
}

const KEY = "ui.titleBarLook";
const IMAGE_SIZE = 128;

function svg(body: string, background: string): string {
    const doc = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
        `<rect width="64" height="64" rx="14" fill="${background}"/>${body}</svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(doc)}`;
}

/** Simple original icons (no logos or characters) */
export const BUILTIN_ICONS: { id: string; label: string; src: string }[] = [
    {
        id: "pickaxe", label: "Pickaxe", src: svg(
            `<path d="M14 22 Q32 6 50 22 Q32 14 14 22Z" fill="#cfd8dc" stroke="#90a4ae" stroke-width="2" stroke-linejoin="round"/>` +
            `<rect x="29" y="17" width="6" height="36" rx="3" fill="#a1662f" transform="rotate(0 32 35)"/>`, "#37474f"),
    },
    {
        id: "crystal", label: "Crystal", src: svg(
            `<path d="M32 8 L46 24 L32 56 L18 24Z" fill="#7c4dff"/>` +
            `<path d="M32 8 L38 24 L32 56 L26 24Z" fill="#b388ff"/>` +
            `<path d="M18 24 H46" stroke="#ede7f6" stroke-width="2"/>`, "#1a1035"),
    },
    {
        id: "mug", label: "Mug", src: svg(
            `<rect x="16" y="22" width="24" height="30" rx="4" fill="#ffb300"/>` +
            `<path d="M40 28 h6 a5 5 0 0 1 5 5 v6 a5 5 0 0 1 -5 5 h-6" fill="none" stroke="#ffb300" stroke-width="4"/>` +
            `<path d="M14 24 q4 -10 10 -6 q4 -6 10 -1 q6 -3 8 5 Z" fill="#fff8e1"/>` +
            `<path d="M22 30 v16 M28 30 v16 M34 30 v16" stroke="#ff8f00" stroke-width="2"/>`, "#3e2723"),
    },
    {
        id: "mushroom", label: "Mushroom", src: svg(
            `<path d="M10 34 Q12 12 32 12 Q52 12 54 34Z" fill="#e53935"/>` +
            `<circle cx="22" cy="24" r="4" fill="#fff"/><circle cx="36" cy="20" r="3" fill="#fff"/><circle cx="44" cy="28" r="3" fill="#fff"/>` +
            `<rect x="24" y="34" width="16" height="18" rx="6" fill="#fff3e0"/>`, "#1b5e20"),
    },
    {
        id: "gear", label: "Gear", src: svg(
            `<g transform="translate(32 32)" fill="#b0bec5">` +
            Array.from({length: 8}, (_, i) => `<rect x="-4" y="-22" width="8" height="10" rx="2" transform="rotate(${i * 45})"/>`).join("") +
            `<circle r="15"/></g><circle cx="32" cy="32" r="6" fill="#263238"/>`, "#263238"),
    },
    {
        id: "flame", label: "Flame", src: svg(
            `<path d="M32 8 C40 20 50 26 48 40 C46 52 38 56 32 56 C26 56 18 52 16 40 C15 30 22 26 24 18 C28 26 30 28 32 8Z" fill="#ff6d00"/>` +
            `<path d="M32 30 C36 36 40 40 38 46 C37 51 34 53 32 53 C30 53 27 51 26 46 C25 41 29 38 32 30Z" fill="#ffd54f"/>`, "#3e1500"),
    },
    {
        id: "planet", label: "Planet", src: svg(
            `<circle cx="32" cy="32" r="14" fill="#26a69a"/>` +
            `<ellipse cx="32" cy="32" rx="26" ry="8" fill="none" stroke="#ffcc80" stroke-width="3" transform="rotate(-20 32 32)"/>` +
            `<circle cx="14" cy="14" r="1.5" fill="#fff"/><circle cx="52" cy="12" r="1" fill="#fff"/><circle cx="50" cy="52" r="1.5" fill="#fff"/>`, "#0d1b2a"),
    },
    {
        id: "terminal", label: "Terminal", src: svg(
            `<rect x="8" y="12" width="48" height="40" rx="5" fill="#111" stroke="#4caf50" stroke-width="2"/>` +
            `<path d="M16 26 l8 6 l-8 6" fill="none" stroke="#4caf50" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>` +
            `<rect x="28" y="38" width="12" height="3" rx="1.5" fill="#4caf50"/>`, "#1b1b1b"),
    },
    {
        id: "rocket", label: "Rocket", src: svg(
            `<path d="M32 8 C42 16 44 30 40 44 H24 C20 30 22 16 32 8Z" fill="#eceff1"/>` +
            `<circle cx="32" cy="26" r="5" fill="#29b6f6"/>` +
            `<path d="M24 36 L16 46 L24 44Z M40 36 L48 46 L40 44Z" fill="#ef5350"/>` +
            `<path d="M27 44 Q32 58 37 44Z" fill="#ffa726"/>`, "#1a237e"),
    },
    {
        id: "skull", label: "Skull", src: svg(
            `<path d="M32 10 C46 10 52 20 52 30 C52 38 47 42 44 44 V52 H20 V44 C17 42 12 38 12 30 C12 20 18 10 32 10Z" fill="#eeeeee"/>` +
            `<circle cx="24" cy="31" r="5" fill="#212121"/><circle cx="40" cy="31" r="5" fill="#212121"/>` +
            `<path d="M32 36 l-3 6 h6Z" fill="#212121"/><path d="M26 52 v-5 M32 52 v-5 M38 52 v-5" stroke="#9e9e9e" stroke-width="2"/>`, "#4a148c"),
    },
    {
        id: "shield", label: "Shield", src: svg(
            `<path d="M32 8 L52 16 V30 C52 44 42 52 32 56 C22 52 12 44 12 30 V16Z" fill="#1e88e5"/>` +
            `<path d="M32 14 L46 20 V30 C46 40 39 46 32 50Z" fill="#64b5f6"/>`, "#0d2137"),
    },
    {
        id: "heart", label: "Heart", src: svg(
            `<path d="M32 52 C14 40 10 30 12 22 C14 14 24 12 32 22 C40 12 50 14 52 22 C54 30 50 40 32 52Z" fill="#ec407a"/>`, "#311b2b"),
    },
];

let data: LookData = {};
let loaded = false;
let version = 0;
let editing: LookTarget | null = null;
const listeners = new Set<() => void>();

function notify() {
    version++;
    listeners.forEach(l => l());
}

async function save() {
    notify();
    await (await StorageAPI.getSettings()).setValue(KEY, JSON.stringify(data));
}

const MIME: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
    svg: "image/svg+xml", bmp: "image/bmp", ico: "image/x-icon",
};

/** Read an image file and scale it to fit IMAGE_SIZE × IMAGE_SIZE (PNG data URL) */
export async function imageFileToDataUrl(path: string): Promise<string> {
    const ext = path.split(".").pop()?.toLowerCase() ?? "";
    const type = MIME[ext];
    if (!type) throw new Error("not-an-image");
    const bytes = await readFile(path);
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], {type}));
    try {
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(new Error("not-an-image"));
            img.src = url;
        });
        const w = img.naturalWidth || IMAGE_SIZE;
        const h = img.naturalHeight || IMAGE_SIZE;
        const scale = Math.min(IMAGE_SIZE / w, IMAGE_SIZE / h, ext === "svg" ? Infinity : 1) || 1;
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("not-an-image");
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL("image/png");
    } finally {
        URL.revokeObjectURL(url);
    }
}

export const TitleBarLook = {
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },

    version(): number {
        return version;
    },

    async init(): Promise<void> {
        if (loaded) return;
        loaded = true;
        try {
            const raw = await (await StorageAPI.getSettings()).getValue(KEY);
            if (raw) data = JSON.parse(raw);
        } catch {
            data = {};
        }
        notify();
    },

    /** Picture to show, or undefined for the default (the cat / the generic profile icon) */
    src(target: LookTarget, _version?: number): string | undefined {
        const choice = data[target];
        if (!choice) return undefined;
        if (choice.kind === "image") return choice.dataUrl;
        return BUILTIN_ICONS.find(i => i.id === choice.id)?.src;
    },

    choice(target: LookTarget, _version?: number): IconChoice | undefined {
        return data[target];
    },

    async set(target: LookTarget, choice: IconChoice | null): Promise<void> {
        data = {...data};
        if (choice) data[target] = choice;
        else delete data[target];
        await save();
    },

    // ----- picker dialog -----

    editing(_version?: number): LookTarget | null {
        return editing;
    },

    openPicker(target: LookTarget): void {
        editing = target;
        notify();
    },

    closePicker(): void {
        editing = null;
        notify();
    },
};
