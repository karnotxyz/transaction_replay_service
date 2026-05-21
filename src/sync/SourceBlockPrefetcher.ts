import logger from "../logger.js";
import { SourceBlockWithTxs } from "../types.js";

type SourceBlockFetcher = (blockNumber: number) => Promise<SourceBlockWithTxs>;

/**
 * Keeps a small window of source blocks in flight so replay does not stall
 * on original-node block fetches between completed blocks.
 */
export class SourceBlockPrefetcher {
  private readonly pending = new Map<number, Promise<SourceBlockWithTxs>>();
  private nextFutureBlockToSchedule: number | null = null;

  constructor(
    private readonly fetchBlock: SourceBlockFetcher,
    private readonly prefetchCount: number,
  ) {}

  prime(currentBlock: number, highestKnownBlock: number): void {
    this.scheduleWindow(currentBlock, highestKnownBlock);
  }

  async take(
    blockNumber: number,
    highestKnownBlock: number,
  ): Promise<SourceBlockWithTxs> {
    this.scheduleWindow(blockNumber, highestKnownBlock);

    const blockPromise = this.pending.get(blockNumber);
    if (!blockPromise) {
      throw new Error(`Source block ${blockNumber} was not scheduled`);
    }

    try {
      return await blockPromise;
    } finally {
      this.pending.delete(blockNumber);
      if (
        this.nextFutureBlockToSchedule === null ||
        this.nextFutureBlockToSchedule < blockNumber + 1
      ) {
        this.nextFutureBlockToSchedule = blockNumber + 1;
      }
      if (this.prefetchCount > 0) {
        this.scheduleWindow(blockNumber + 1, highestKnownBlock);
      }
    }
  }

  private scheduleWindow(currentBlock: number, highestKnownBlock: number): void {
    this.schedule(currentBlock);

    if (this.prefetchCount <= 0) {
      return;
    }

    if (
      this.nextFutureBlockToSchedule === null ||
      this.nextFutureBlockToSchedule < currentBlock + 1
    ) {
      this.nextFutureBlockToSchedule = currentBlock + 1;
    }

    const windowEnd = Math.min(
      highestKnownBlock,
      currentBlock + this.prefetchCount,
    );

    while (this.nextFutureBlockToSchedule <= windowEnd) {
      this.schedule(this.nextFutureBlockToSchedule);
      this.nextFutureBlockToSchedule++;
    }
  }

  private schedule(blockNumber: number): void {
    if (this.pending.has(blockNumber)) {
      return;
    }

    logger.debug(`📥 Prefetching source block ${blockNumber}`);

    const blockPromise = this.fetchBlock(blockNumber).catch((error) => {
      this.pending.delete(blockNumber);
      throw error;
    });

    this.pending.set(blockNumber, blockPromise);
  }
}
