import { execFile } from "node:child_process";

/*
 * The author's GitHub connection (D5): an OAuth App's device flow, or the gh CLI's account, with the
 * token kept in the operating system's keychain. The token never leaves the server: not in a
 * response, a log line, a file, or a repository's git config.
 */

/** The registered gh-writer OAuth App's client ID: public, and shipped in the app. Unset until the owner registers it (#100). */
export const GITHUB_CLIENT_ID: string | undefined = undefined;

/** classic OAuth scopes: private repositories (contents, issues, creating them), and who the author is. */
export const SCOPES = ["repo", "read:user"];

const SERVICE = "gh-writer";
const ACCOUNT = "github";

/** Where the token lives. */
export interface TokenStore {
  get(): Promise<string | undefined>;
  set(token: string): Promise<void>;
  delete(): Promise<void>;
}

export type GitHubErrorCode = "NO_CLIENT_ID" | "NO_KEYCHAIN" | "NO_SIGN_IN" | "NO_GH" | "GITHUB";

export class GitHubError extends Error {
  readonly code: GitHubErrorCode;

  constructor(code: GitHubErrorCode, message: string) {
    super(message);
    this.name = "GitHubError";
    this.code = code;
  }
}

/** The OS keychain (macOS Keychain, Windows Credential Manager, the Secret Service on Linux). Never a plain-text file. */
export function keychainStore(): TokenStore {
  const entry = async () => {
    try {
      const { AsyncEntry } = await import("@napi-rs/keyring");
      return new AsyncEntry(SERVICE, ACCOUNT);
    } catch {
      throw noKeychain();
    }
  };
  const call = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch {
      throw noKeychain();
    }
  };
  return {
    get: async () => {
      const e = await entry();
      return (await call(() => e.getPassword())) ?? undefined;
    },
    set: async (token) => {
      const e = await entry();
      await call(() => e.setPassword(token));
    },
    delete: async () => {
      const e = await entry();
      await call(() => e.deletePassword());
    },
  };
}

const noKeychain = () =>
  new GitHubError(
    "NO_KEYCHAIN",
    "gh-writer keeps your GitHub sign-in in the system keychain, and couldn't reach it. On Linux, install and unlock a Secret Service keyring (GNOME Keyring or KWallet), then try again.",
  );

/** A store in memory, gone when the server stops: for tests (GH_WRITER_TOKEN_STORE=memory). */
export function memoryStore(): TokenStore {
  let token: string | undefined;
  return {
    get: async () => token,
    set: async (t) => void (token = t),
    delete: async () => void (token = undefined),
  };
}

/** The token of the gh CLI's signed-in account, if there is one. */
export function ghToken(): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile("gh", ["auth", "token", "--hostname", "github.com"], { timeout: 10_000, env: { ...process.env, GH_PROMPT_DISABLED: "1" } }, (error, stdout) =>
      resolve(error ? undefined : stdout.trim() || undefined),
    );
  });
}

export interface GitHubAccount {
  login: string;
  name?: string;
  avatarUrl?: string;
}

/** What the app shows about the connection. */
export interface AccountStatus {
  signedIn: boolean;
  /** Who, when signed in (unknown while offline, until GitHub has been reached once). */
  account?: GitHubAccount;
  /** Whether sign-in with a code on github.com is available (an OAuth App client ID is set). */
  deviceFlow: boolean;
  /** The gh CLI's account, offered as a shortcut while signed out. */
  gh?: { login: string };
  /** Set once after GitHub stopped accepting the stored token (revoked or expired): it has been forgotten. */
  expired?: boolean;
  /** Signed in, but GitHub couldn't be reached to say who as. */
  offline?: boolean;
  /** Why the keychain couldn't be read, when it couldn't. */
  keychain?: string;
}

export interface DeviceCode {
  userCode: string;
  verificationUri: string;
  /** Seconds until the code expires. */
  expiresIn: number;
  /** Seconds to wait between polls. */
  interval: number;
}

export type PollResult =
  | { status: "pending"; interval: number }
  | { status: "expired" | "denied" | "none" }
  | { status: "done"; account: AccountStatus };

export interface GitHubOptions {
  clientId?: string | undefined;
  /** github.com, or a fake GitHub in tests. */
  webUrl?: string;
  /** api.github.com, or a fake GitHub in tests. */
  apiUrl?: string;
  store?: TokenStore;
  /** The gh CLI's token, if it has one. */
  gh?: () => Promise<string | undefined>;
  fetch?: typeof fetch;
}

/**
 * The connection to GitHub. Signed out, it offers the device flow and, if gh is signed in, its
 * account. Signed in, it knows who the author is; when GitHub refuses the token, it forgets it and
 * reports `expired` once, rather than failing again and again.
 */
export class GitHub {
  readonly clientId: string | undefined;
  readonly webUrl: string;
  readonly apiUrl: string;
  #store: TokenStore;
  #gh: () => Promise<string | undefined>;
  #fetch: typeof fetch;
  #account: GitHubAccount | undefined;
  #expired = false;
  #device: { deviceCode: string; interval: number; expiresAt: number } | undefined;
  /** The gh CLI's account, looked up at most once a minute. */
  #ghCache: { at: number; value: Promise<{ token: string; account: GitHubAccount } | undefined> } | undefined;

  constructor({ clientId = GITHUB_CLIENT_ID, webUrl = "https://github.com", apiUrl = "https://api.github.com", store = keychainStore(), gh = ghToken, fetch: f = fetch }: GitHubOptions = {}) {
    this.clientId = clientId || undefined;
    this.webUrl = webUrl.replace(/\/$/, "");
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.#store = store;
    this.#gh = gh;
    this.#fetch = f;
  }

  /** From the environment: GH_WRITER_GITHUB_CLIENT_ID, GH_WRITER_GITHUB_URL, GH_WRITER_GITHUB_API_URL, GH_WRITER_TOKEN_STORE=memory. */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): GitHub {
    return new GitHub({
      clientId: env.GH_WRITER_GITHUB_CLIENT_ID || GITHUB_CLIENT_ID,
      ...(env.GH_WRITER_GITHUB_URL ? { webUrl: env.GH_WRITER_GITHUB_URL } : {}),
      ...(env.GH_WRITER_GITHUB_API_URL ? { apiUrl: env.GH_WRITER_GITHUB_API_URL } : {}),
      ...(env.GH_WRITER_TOKEN_STORE === "memory" ? { store: memoryStore() } : {}),
    });
  }

  /** The stored token, for git and the API. Undefined when signed out (or the keychain can't be read). */
  async token(): Promise<string | undefined> {
    return this.#store.get().catch(() => undefined);
  }

  async status(): Promise<AccountStatus> {
    const deviceFlow = Boolean(this.clientId);
    let keychain: string | undefined;
    const token = await this.#store.get().catch((e: unknown) => void (keychain = e instanceof Error ? e.message : String(e)));
    if (token) {
      try {
        const account = await this.#who(token);
        if (account) return { signedIn: true, account, deviceFlow };
      } catch {
        // Offline, or GitHub is down: still signed in, as far as anyone knows.
        return { signedIn: true, ...(this.#account ? { account: this.#account } : {}), deviceFlow, offline: true };
      }
    }
    const expired = this.#expired;
    this.#expired = false;
    const gh = await this.#ghAccount();
    return { signedIn: false, deviceFlow, ...(gh ? { gh: { login: gh.account.login } } : {}), ...(expired ? { expired } : {}), ...(keychain ? { keychain } : {}) };
  }

  /** Start the device flow: the author enters the code at the verification address. */
  async startDevice(): Promise<DeviceCode> {
    if (!this.clientId) throw new GitHubError("NO_CLIENT_ID", "Signing in with a code isn't set up in this copy of gh-writer (it has no GitHub OAuth App client ID). Sign in with the gh CLI instead: gh auth login.");
    const res = await this.#post(`${this.webUrl}/login/device/code`, { client_id: this.clientId, scope: SCOPES.join(" ") });
    const body = (await res.json()) as { device_code?: string; user_code?: string; verification_uri?: string; expires_in?: number; interval?: number; error_description?: string };
    if (!res.ok || !body.device_code || !body.user_code || !body.verification_uri) {
      throw new GitHubError("GITHUB", `GitHub didn't start the sign-in: ${body.error_description ?? res.statusText}`);
    }
    const interval = body.interval ?? 5;
    const expiresIn = body.expires_in ?? 900;
    this.#device = { deviceCode: body.device_code, interval, expiresAt: Date.now() + expiresIn * 1000 };
    return { userCode: body.user_code, verificationUri: body.verification_uri, expiresIn, interval };
  }

  /** Ask GitHub once whether the author has entered the code. */
  async pollDevice(): Promise<PollResult> {
    const device = this.#device;
    if (!device || !this.clientId) return { status: "none" };
    if (Date.now() > device.expiresAt) {
      this.#device = undefined;
      return { status: "expired" };
    }
    const res = await this.#post(`${this.webUrl}/login/oauth/access_token`, {
      client_id: this.clientId,
      device_code: device.deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    const body = (await res.json()) as { access_token?: string; error?: string; interval?: number; error_description?: string };
    if (body.access_token) {
      this.#device = undefined;
      return { status: "done", account: await this.#signIn(body.access_token) };
    }
    switch (body.error) {
      case "authorization_pending":
        return { status: "pending", interval: device.interval };
      case "slow_down":
        device.interval = body.interval ?? device.interval + 5;
        return { status: "pending", interval: device.interval };
      case "expired_token":
        this.#device = undefined;
        return { status: "expired" };
      case "access_denied":
        this.#device = undefined;
        return { status: "denied" };
      default:
        throw new GitHubError("GITHUB", `GitHub didn't finish the sign-in: ${body.error_description ?? body.error ?? res.statusText}`);
    }
  }

  /** Sign in with the gh CLI's account. */
  async useGh(): Promise<AccountStatus> {
    this.#ghCache = undefined;
    const gh = await this.#ghAccount();
    if (!gh) throw new GitHubError("NO_GH", "The gh CLI isn't signed in to GitHub on this computer. Run gh auth login, or sign in with a code.");
    return this.#signIn(gh.token, gh.account);
  }

  /** Forget the token. gh-writer has no client secret, so it can't revoke it: github.com → Settings → Applications can. */
  async signOut(): Promise<void> {
    this.#device = undefined;
    this.#account = undefined;
    await this.#store.delete();
  }

  /**
   * A request to the GitHub API as the author. A 401 means the token is no longer good: it is
   * forgotten, and NO_SIGN_IN is thrown.
   */
  async api(path: string, init: { method?: string; body?: unknown } = {}): Promise<Response> {
    const token = await this.#store.get();
    if (!token) throw new GitHubError("NO_SIGN_IN", "Connect gh-writer to GitHub first.");
    const res = await this.#request(token, path, init);
    if (res.status === 401) {
      await this.#forget();
      throw new GitHubError("NO_SIGN_IN", "GitHub no longer accepts gh-writer's sign-in (it was revoked or has expired). Connect to GitHub again.");
    }
    return res;
  }

  async #signIn(token: string, known?: GitHubAccount): Promise<AccountStatus> {
    const account = known ?? (await this.#who(token, { remember: false }));
    if (!account) throw new GitHubError("GITHUB", "GitHub didn't accept the new sign-in. Try again.");
    await this.#store.set(token);
    this.#account = account;
    this.#expired = false;
    return { signedIn: true, account, deviceFlow: Boolean(this.clientId) };
  }

  /** Who the token belongs to; undefined (and the token forgotten) when GitHub refuses it. */
  async #who(token: string, { remember = true } = {}): Promise<GitHubAccount | undefined> {
    if (remember && this.#account) return this.#account;
    const res = await this.#request(token, "/user");
    if (res.status === 401) {
      if (remember) await this.#forget();
      return undefined;
    }
    if (!res.ok) throw new GitHubError("GITHUB", `GitHub answered ${res.status} when asked who you are.`);
    const user = (await res.json()) as { login: string; name?: string | null; avatar_url?: string };
    const account: GitHubAccount = { login: user.login, ...(user.name ? { name: user.name } : {}), ...(user.avatar_url ? { avatarUrl: user.avatar_url } : {}) };
    if (remember) this.#account = account;
    return account;
  }

  #ghAccount(): Promise<{ token: string; account: GitHubAccount } | undefined> {
    if (this.#ghCache && Date.now() - this.#ghCache.at < 60_000) return this.#ghCache.value;
    const value = (async () => {
      const token = await this.#gh().catch(() => undefined);
      if (!token) return undefined;
      const account = await this.#who(token, { remember: false }).catch(() => undefined);
      return account && { token, account };
    })();
    this.#ghCache = { at: Date.now(), value };
    return value;
  }

  async #forget(): Promise<void> {
    this.#account = undefined;
    this.#expired = true;
    await this.#store.delete().catch(() => {});
  }

  #request(token: string, path: string, { method = "GET", body }: { method?: string; body?: unknown } = {}): Promise<Response> {
    return this.#fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "gh-writer",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  #post(url: string, form: Record<string, string>): Promise<Response> {
    return this.#fetch(url, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "gh-writer" },
      body: new URLSearchParams(form).toString(),
    });
  }
}
