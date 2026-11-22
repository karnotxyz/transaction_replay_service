export function getMempoolTransactionSuffix<T>(
  transactions: T[],
  startTxIndex: number,
  blockNumber: number,
): T[] {
  if (
    !Number.isSafeInteger(startTxIndex) ||
    startTxIndex < 0 ||
    startTxIndex > transactions.length
  ) {
    throw new Error(
      `Invalid mempool startTxIndex ${startTxIndex} for source block ${blockNumber} with ${transactions.length} transactions`,
    );
  }
  return transactions.slice(startTxIndex);
}
