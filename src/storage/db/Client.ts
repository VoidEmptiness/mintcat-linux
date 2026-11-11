import {drizzle} from "drizzle-orm/sqlite-proxy";
import Database from "@tauri-apps/plugin-sql";
import {path} from "@tauri-apps/api";
import {configDir} from "@tauri-apps/api/path";


let dbInstance: Awaited<ReturnType<typeof Database.load>> | undefined;
let dbInitPromise: Promise<Awaited<ReturnType<typeof Database.load>>> | null = null;

/**
 * 关闭数据库连接并清空单例，便于恢复流程或重试前释放文件句柄。
 * 下次 getDb() 会重新打开。
 */
export async function closeDb(): Promise<void> {
    if (dbInstance) {
        try {
            await dbInstance.close();
        } finally {
            dbInstance = undefined;
            dbInitPromise = null;
        }
    } else {
        dbInitPromise = null;
    }
}

export async function initDb() {
    // If instance exists, return it immediately
    if (dbInstance) {
        return dbInstance;
    }

    // If initialization is in progress, wait for it
    if (dbInitPromise) {
        return dbInitPromise;
    }

    // Start initialization
    dbInitPromise = (async () => {
        try {
            const configPath = await path.join(await configDir(), 'com.mint.cat', 'mintcat.sqlite');
            dbInstance = await Database.load(`sqlite:${configPath}`);
            return dbInstance;
        } finally {
            // Clear the promise after initialization completes (success or failure)
            dbInitPromise = null;
        }
    })();

    return dbInitPromise;
}

export async function getDb() {
    const db = await initDb();

    // 定义 proxy 回调：Drizzle 调用时会传入 SQL、参数和方法
    const callback = async (
        sql: string,
        params: any[],
        method: "run" | "all" | "values" | "get",
    ) => {
        //console.trace(sql, params, method);

        if (method === "run") {
            await db.execute(sql, params);
            return {rows: []};
        }

        const rows = (await db.select(sql, params)) as any[];
        //console.trace(rows);

        return {rows: rows.map((row) => Object.values(row))};
    };

    return drizzle(callback);
}

/**
 * Write a consistent copy of the live database to `dest` (which must not exist yet). A plain
 * file copy would miss recent changes: the database runs in WAL mode, so they can still be in
 * mintcat.sqlite-wal. The copy is set to WAL mode too, like MINTCAT's own database.
 */
export async function snapshotDatabase(dest: string): Promise<void> {
    const db = await initDb();
    await db.execute("VACUUM INTO $1", [dest]);
    try {
        const copy = await Database.load(`sqlite:${dest}`);
        try {
            await copy.select("PRAGMA journal_mode=WAL");
        } finally {
            // only this database: close() without a name closes MINTCAT's own pool too
            await copy.close(copy.path);
        }
    } catch (e) {
        console.warn("[db] could not set WAL mode on the snapshot (fixed at startup after a restore)", e);
    }
}
