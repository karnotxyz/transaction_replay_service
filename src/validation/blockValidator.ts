import logger from "../logger.js";
import { getLatestBlockNumber } from "../operations/blockOperations.js";
import { syncingProvider_v9 } from "../providers.js";
import { blockValidationRetry } from "../retry/index.js";

/**
 * Validate that a block is ready to be synced
 * Ensures the syncing node is at block N-1 before syncing block N
 */
export async function validateBlock(currentBlock: number): Promise<void> {
  return blockValidationRetry.execute(async () => {
    const latestBlockNumber = await getLatestBlockNumber(syncingProvider_v9);

    if (latestBlockNumber + 1 !== currentBlock) {
      throw new Error(
        `Sync block ${currentBlock} is not 1 + ${latestBlockNumber}`,
      );
    }

    logger.debug(
      `✅ Block ${currentBlock} validated (syncing node at ${latestBlockNumber})`,
    );
  }, `validateBlock(${currentBlock})`);
}
