/**
 * Release source: the stage-N branch archive from a public GitHub repository and the stage
 * package from a GitHub Release asset. No login or token: GitHub is a download source only.
 */
import { readZip } from './archive.ts';
import { ContentVerificationError, parseManifest, stageEntry } from './manifest.ts';
import type { StageManifest } from './manifest.ts';
import { verifyPackageZip, verifyStage } from './source.ts';
import type { ContentSource, FetchedStage } from './source.ts';

export interface GitHubSourceOptions {
  /** "owner/name" of the public repository with the stage-N branches and the releases. */
  repository: string;
  /** https://github.com, or a local mock server in tests. */
  baseUrl?: string;
  /** A release tag such as "v1.0.0", or "latest". */
  release?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  maxBytes?: number;
}

export class DownloadError extends Error {}

const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const RELEASE = /^(latest|[A-Za-z0-9._-]{1,100})$/;

/** Only https, except loopback http for tests and local mirrors. */
export function validateBaseUrl(raw: string): URL {
  const url = new URL(raw);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`Content URL must use https: ${raw}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`Content URL must not contain credentials, a query or a fragment: ${raw}`);
  }
  return url;
}

export class GitHubContentSource implements ContentSource {
  readonly kind = 'github';
  private readonly base: string;
  private readonly repository: string;
  private readonly release: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly maxBytes: number;

  constructor(options: GitHubSourceOptions) {
    if (!REPOSITORY.test(options.repository) || options.repository.split('/').some((part) => /^\.+$/.test(part))) {
      throw new Error(`Invalid repository: ${options.repository}`);
    }
    const release = options.release ?? 'latest';
    if (!RELEASE.test(release)) {
      throw new Error(`Invalid release tag: ${release}`);
    }
    this.base = validateBaseUrl(options.baseUrl ?? 'https://github.com').href.replace(/\/$/, '');
    this.repository = options.repository;
    this.release = release;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.retries = options.retries ?? 3;
    this.maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
  }

  describe(): string {
    return `${this.base}/${this.repository} (${this.release})`;
  }

  releaseAssetUrl(file: string): string {
    const name = encodeURIComponent(file);
    return this.release === 'latest'
      ? `${this.base}/${this.repository}/releases/latest/download/${name}`
      : `${this.base}/${this.repository}/releases/download/${encodeURIComponent(this.release)}/${name}`;
  }

  branchArchiveUrl(branch: string): string {
    return `${this.base}/${this.repository}/archive/refs/heads/${encodeURIComponent(branch)}.zip`;
  }

  /** Downloads into memory with a size limit and a timeout, retrying network errors and 5xx. */
  async download(url: string, signal?: AbortSignal): Promise<Uint8Array> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      signal?.throwIfAborted();
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
      try {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const response = await this.fetchImpl(url, {
          redirect: 'follow',
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: { 'User-Agent': 'BugDetective' },
        });
        if (response.status >= 500) {
          lastError = new DownloadError(`${url}: HTTP ${response.status}`);
          continue;
        }
        if (!response.ok || !response.body) {
          throw new DownloadError(`${url}: HTTP ${response.status}`);
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > this.maxBytes) {
            throw new DownloadError(`${url}: larger than ${this.maxBytes} bytes`);
          }
          chunks.push(chunk);
        }
        return new Uint8Array(Buffer.concat(chunks));
      } catch (error) {
        if (error instanceof DownloadError || signal?.aborted) {
          throw error;
        }
        lastError = error;
      }
    }
    throw new DownloadError(`Download failed: ${url} (${lastError instanceof Error ? lastError.message : String(lastError)})`);
  }

  async manifest(signal?: AbortSignal): Promise<StageManifest> {
    const bytes = await this.download(this.releaseAssetUrl('manifest.json'), signal);
    try {
      return parseManifest(JSON.parse(Buffer.from(bytes).toString('utf8')));
    } catch (error) {
      throw error instanceof ContentVerificationError ? error : new ContentVerificationError('The stage manifest is not valid JSON');
    }
  }

  async fetchStage(stage: number, signal?: AbortSignal): Promise<FetchedStage> {
    const entry = stageEntry(await this.manifest(signal), stage);
    const packageZip = verifyPackageZip(entry, await this.download(this.releaseAssetUrl(entry.package.file), signal));
    const code = await this.download(this.branchArchiveUrl(entry.branch), signal);
    return verifyStage({
      entry,
      packageZip,
      packageFiles: readZip(packageZip),
      codeFiles: readZip(code, { stripTopDirectory: true }),
    });
  }
}
