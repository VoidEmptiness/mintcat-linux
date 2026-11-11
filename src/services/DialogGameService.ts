import { StorageAPI } from "@/storage";
import {t} from "i18next";
import {logActivity} from "@/services/ActivityLog";

export class DialogGameService {
    public async getAllGames() {
        const gameDAO = await StorageAPI.getGames();
        return await gameDAO.getAllGames();
    }

    public async setGameActive(selectedGameId: number): Promise<void> {
        const gameDAO = await StorageAPI.getGames();
        const gamesList = await gameDAO.getAllGames();

        for (const game of gamesList) {
            const shouldBeActive = game.id === selectedGameId;
            if (game.isActive !== shouldBeActive) {
                await gameDAO.setGameActive(game.id!, shouldBeActive);
                if (shouldBeActive) {
                    await logActivity('info', t("log.game.switched", {name: game.displayName || game.name}), game.installPath || undefined, 'game');
                }
            }
        }
    }

    public async updateGameInstallPath(gameId: number, path: string): Promise<void> {
        const gameDAO = await StorageAPI.getGames();
        await gameDAO.updateGame(gameId, { installPath: path });
        const game = (await gameDAO.getAllGames()).find(g => g.id === gameId);
        await logActivity('info', t("log.game.pathSet", {name: game?.displayName || game?.name || ""}), path, 'game');
    }
}
