export function resolveRpcUrl(baseUrl: string, path: string): string {
  const trimmedBaseUrl = baseUrl.replace(/\/$/, "");

  try {
    const parsed = new URL(trimmedBaseUrl);
    if (parsed.pathname.includes("/rpc/v")) {
      return trimmedBaseUrl;
    }
  } catch {
    if (trimmedBaseUrl.includes("/rpc/v")) {
      return trimmedBaseUrl;
    }
  }

  return `${trimmedBaseUrl}${path}`;
}
