/**
 * Returns Madara's process-health endpoint for an RPC URL.
 * RPC version paths are discarded because `/health` is served at the origin root.
 */
export function madaraHealthUrl(rpcUrl: string): string {
  return new URL("/health", rpcUrl).toString();
}
