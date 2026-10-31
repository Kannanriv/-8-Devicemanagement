export interface ClientOptions {
  baseUrl?: string;
  tenantId?: string;
  actor?: string;
  fetch?: typeof fetch;
}

/** Thin typed REST client. Endpoint list: docs/api-contract.md. */
export class Hash8Client {
  readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://localhost:4000/api/v1").replace(/\/$/, "");
    this.headers = { "content-type": "application/json" };
    if (opts.tenantId) this.headers["x-tenant-id"] = opts.tenantId;
    if (opts.actor) this.headers["x-actor"] = opts.actor;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : undefined;
    if (!res.ok) {
      const msg = json?.error?.message ?? res.statusText;
      throw new Error(`${method} ${path} → ${res.status}: ${msg}`);
    }
    return json as T;
  }

  get<T>(path: string) {
    return this.request<T>("GET", path);
  }
  post<T>(path: string, body?: unknown) {
    return this.request<T>("POST", path, body ?? {});
  }
  patch<T>(path: string, body: unknown) {
    return this.request<T>("PATCH", path, body);
  }
  put<T>(path: string, body: unknown) {
    return this.request<T>("PUT", path, body);
  }
}
