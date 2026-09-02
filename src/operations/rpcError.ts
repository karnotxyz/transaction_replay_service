/** JSON-RPC error returned in an otherwise successful HTTP response. */
export interface RpcErrorPayload {
  code: number;
  message: string;
  data?: unknown;
}

/** Decides whether a JSON-RPC error is retryable or must fail the submission. */
export function classifyRpcError(
  error: RpcErrorPayload | undefined
): "retry_account_validation" | Error | null {
  if (!error) {
    return null;
  }
  if (error.code === 55) {
    return "retry_account_validation";
  }
  return new Error(formatRpcError(error));
}

/** Formats a JSON-RPC error without losing optional server-provided details. */
export function formatRpcError(error: RpcErrorPayload): string {
  if (error.data === undefined || error.data === null) {
    return `RPC error ${error.code}: ${error.message}`;
  }

  const details =
    typeof error.data === "string" ? error.data : JSON.stringify(error.data);
  return `RPC error ${error.code}: ${error.message} (${details})`;
}
