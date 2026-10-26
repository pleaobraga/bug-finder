/**
 * The player's workspace: a Git repository in the `bugdetective-workspace` Docker volume, mounted
 * at /workspaces/supportdesk in a long-running container. All Git operations run in that
 * container with `docker exec`. Shell scripts below are constants; variable data is only ever
 * passed as positional arguments ("$1", "$2"), never interpolated into the script.
 */
import { createHash } from 'node:crypto';
import { writeTar } from './content/archive.ts';
import type { ArchiveFile } from './content/archive.ts';
import { LABEL, mountArg } from './docker.ts';
import type { ContainerInfo, Docker } from './docker.ts';
import type { RunOptions } from './process.ts';

export const WORKSPACE_DIR = '/workspaces/supportdesk';
export const CACHE_DIR = '/opt/bugdetective-cache';
export interface ResourceNames {
  prefix: string;
  container: string;
  volume: string;
  vscodeVolume: string;
  cacheVolume: string;
}

/** Docker resource names. Tests use another prefix so they never touch a player's volume. */
export function resourceNames(prefix = 'bugdetective'): ResourceNames {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(prefix)) {
    throw new Error(`Invalid resource prefix: ${prefix}`);
  }
  return {
    prefix,
    container: `${prefix}-workspace`,
    volume: `${prefix}-workspace`,
    vscodeVolume: `${prefix}-vscode-server`,
    cacheVolume: `${prefix}-qa-cache`,
  };
}
/** Container ports: the forwarder in front of Vite, and the Express API. */
export const CONTAINER_PORTS = { client: 15173, api: 3001 } as const;
const PREFERRED_HOST_PORTS = { client: 5173, api: 3001 } as const;

export const playerBranch = (stage: number) => `player/ticket-${stage}`;

const SCRIPTS = {
  importStage: `set -eu
stage="$1"; message="$2"; src="/tmp/bugdetective-import-$stage"
rm -rf "$src" "$src.index"; mkdir -p "$src"
tar -x -C "$src"
cd ${WORKSPACE_DIR}
if [ ! -d .git ]; then
  git init -q
  git config core.autocrlf false
  git config core.eol lf
  git config user.name "SupportDesk Developer"
  git config user.email "developer@supportdesk.invalid"
fi
if ! git rev-parse -q --verify "refs/tags/stage-$stage" >/dev/null; then
  cd "$src"
  export GIT_DIR=${WORKSPACE_DIR}/.git GIT_WORK_TREE="$src" GIT_INDEX_FILE="$src.index"
  git add -A -f .
  tree=$(git write-tree)
  export GIT_AUTHOR_NAME="Bug Detective" GIT_AUTHOR_EMAIL="stages@bugdetective.invalid"
  export GIT_COMMITTER_NAME="Bug Detective" GIT_COMMITTER_EMAIL="stages@bugdetective.invalid"
  if parent=$(git rev-parse -q --verify refs/heads/bugdetective/stages); then
    commit=$(git commit-tree "$tree" -p "$parent" -m "$message")
  else
    commit=$(git commit-tree "$tree" -m "$message")
  fi
  git update-ref refs/heads/bugdetective/stages "$commit"
  git tag "stage-$stage" "$commit"
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
  cd ${WORKSPACE_DIR}
fi
rm -rf "$src" "$src.index"
git rev-parse "refs/tags/stage-$stage^{commit}"`,

  /** Switches to player/ticket-N. Uncommitted work from the previous ticket is stashed, never lost. */
  checkoutPlayerBranch: `set -eu
stage="$1"; branch="player/ticket-$stage"
cd ${WORKSPACE_DIR}
current=$(git symbolic-ref -q --short HEAD || true)
if [ "$current" != "$branch" ]; then
  if git rev-parse -q --verify HEAD >/dev/null && [ -n "$(git status --porcelain)" ]; then
    git stash push -q -u -m "Bug Detective: uncommitted changes before ticket $stage"
  fi
  if git rev-parse -q --verify "refs/heads/$branch" >/dev/null; then
    git checkout -q "$branch"
  else
    git checkout -q -f -b "$branch" "stage-$stage"
  fi
fi`,

  /** Diff of the working tree (including new files) against the stage commit, without touching the real index. */
  playerDiff: `set -eu
stage="$1"; idx=/tmp/bugdetective-diff.index
cd ${WORKSPACE_DIR}
rm -f "$idx"
if [ -f .git/index ]; then cp .git/index "$idx"; fi
GIT_INDEX_FILE="$idx" git add -A
GIT_INDEX_FILE="$idx" git diff --cached --no-color --no-ext-diff --no-renames "stage-$stage" -- . ':(exclude)package-lock.json'
rm -f "$idx"`,

  installDepsFromCache: `set -eu
key="$1"
cd ${WORKSPACE_DIR}
rm -rf node_modules client/node_modules server/node_modules
tar -xf "${CACHE_DIR}/deps/$key.tar" -C .
printf %s "$key" > node_modules/.bugdetective-deps`,

  bundle: `set -eu
cd ${WORKSPACE_DIR}
rm -f /tmp/bugdetective.bundle
git bundle create -q /tmp/bugdetective.bundle --all >/dev/null 2>&1
cat /tmp/bugdetective.bundle
rm -f /tmp/bugdetective.bundle`,

  /** Checks a bundle in a scratch repository, before anything of the player's is touched. */
  verifyBundle: `set -eu
rm -rf /tmp/bugdetective-verify /tmp/bugdetective-verify.bundle
cat > /tmp/bugdetective-verify.bundle
git init -q /tmp/bugdetective-verify
git -C /tmp/bugdetective-verify bundle verify -q /tmp/bugdetective-verify.bundle >/dev/null
rm -rf /tmp/bugdetective-verify /tmp/bugdetective-verify.bundle`,

  restoreBundle: `set -eu
branch="$1"
cat > /tmp/bugdetective-restore.bundle
cd ${WORKSPACE_DIR}
git init -q
git config core.autocrlf false
git config core.eol lf
git config user.name "SupportDesk Developer"
git config user.email "developer@supportdesk.invalid"
git fetch -q /tmp/bugdetective-restore.bundle "refs/*:refs/*"
git checkout -q -f "$branch"
rm -f /tmp/bugdetective-restore.bundle`,
};

export interface WorkspacePorts {
  client: number;
  api: number;
}

export interface WorkspaceOptions {
  docker: Docker;
  image: string;
  isPortFree: (port: number) => Promise<boolean>;
  names?: ResourceNames;
}

export class Workspace {
  private readonly docker: Docker;
  private readonly image: string;
  private readonly isPortFree: (port: number) => Promise<boolean>;
  private readonly names: ResourceNames;
  private runtimeKey: string | null = null;

  constructor(options: WorkspaceOptions) {
    this.docker = options.docker;
    this.image = options.image;
    this.isPortFree = options.isPortFree;
    this.names = options.names ?? resourceNames();
  }

  get containerName(): string {
    return this.names.container;
  }

  async volumeExists(): Promise<boolean> {
    return this.docker.volumeExists(this.names.volume);
  }

  async info(): Promise<ContainerInfo | null> {
    return this.docker.inspectContainer(this.names.container);
  }

  /** Published host ports, or null when the container does not exist. */
  async ports(): Promise<WorkspacePorts | null> {
    const info = await this.info();
    if (!info) {
      return null;
    }
    return { client: info.ports[CONTAINER_PORTS.client], api: info.ports[CONTAINER_PORTS.api] };
  }

  private async pickPort(preferred: number, avoid: Set<number>): Promise<number> {
    for (let port = preferred; port < preferred + 200; port += 1) {
      if (!avoid.has(port) && (await this.isPortFree(port))) {
        return port;
      }
    }
    throw new Error(`No free port found near ${preferred}`);
  }

  private async create(): Promise<void> {
    const avoid = new Set<number>();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const client = await this.pickPort(PREFERRED_HOST_PORTS.client, avoid);
      avoid.add(client);
      const api = await this.pickPort(PREFERRED_HOST_PORTS.api, avoid);
      avoid.add(api);
      const result = await this.docker.run([
        'run',
        '--detach',
        '--init',
        '--name',
        this.names.container,
        '--label',
        `${LABEL}=workspace`,
        '--mount',
        mountArg({ type: 'volume', src: this.names.volume, dst: WORKSPACE_DIR }),
        '--mount',
        mountArg({ type: 'volume', src: this.names.vscodeVolume, dst: '/home/node/.vscode-server' }),
        '--mount',
        mountArg({ type: 'volume', src: this.names.cacheVolume, dst: CACHE_DIR, readonly: true }),
        '--publish',
        `127.0.0.1:${client}:${CONTAINER_PORTS.client}`,
        '--publish',
        `127.0.0.1:${api}:${CONTAINER_PORTS.api}`,
        this.image,
      ]);
      if (result.code === 0) {
        return;
      }
      await this.docker.removeContainer(this.names.container);
      if (!/port is already allocated|address already in use|ports are not available/i.test(result.stderr)) {
        throw new Error(`Could not start the workspace container: ${result.stderr.trim()}`);
      }
    }
    throw new Error('Could not find free ports for the workspace container');
  }

  /** Creates the volumes and starts the workspace container. The volume (the player's work) is never removed here. */
  async ensureRunning(): Promise<ContainerInfo> {
    await this.docker.createVolume(this.names.volume, 'workspace');
    await this.docker.createVolume(this.names.vscodeVolume, 'vscode-server');
    await this.docker.createVolume(this.names.cacheVolume, 'qa-cache');
    let info = await this.info();
    if (info && info.image !== this.image) {
      // A newer app version ships a newer image: recreate the container, keep the volumes.
      await this.docker.removeContainer(this.names.container);
      info = null;
    }
    if (info && !info.running) {
      const started = await this.docker.run(['container', 'start', this.names.container]);
      if (started.code !== 0) {
        // Usually a published port was taken by another program meanwhile.
        await this.docker.removeContainer(this.names.container);
        info = null;
      }
    }
    if (!info) {
      await this.create();
    }
    const running = await this.info();
    if (!running?.running) {
      throw new Error('The workspace container is not running');
    }
    return running;
  }

  private exec(command: readonly string[], options: Parameters<Docker['exec']>[2] = {}) {
    return this.docker.execChecked(this.names.container, command, { user: 'node', workdir: WORKSPACE_DIR, ...options });
  }

  private script(name: keyof typeof SCRIPTS, args: readonly string[] = [], options: Parameters<Docker['exec']>[2] = {}) {
    return this.exec(['sh', '-c', SCRIPTS[name], 'sh', ...args], options);
  }

  async git(args: readonly string[], options: Parameters<Docker['exec']>[2] = {}): Promise<string> {
    return (await this.exec(['git', ...args], options)).stdout.toString('utf8');
  }

  async hasRepository(): Promise<boolean> {
    const result = await this.docker.exec(this.names.container, ['test', '-d', `${WORKSPACE_DIR}/.git`], { user: 'node' });
    return result.code === 0;
  }

  /** The checked-out branch, or null for a detached HEAD. */
  async currentBranch(): Promise<string | null> {
    const result = await this.docker.exec(this.names.container, ['git', 'symbolic-ref', '-q', '--short', 'HEAD'], {
      user: 'node',
      workdir: WORKSPACE_DIR,
    });
    const branch = result.stdout.toString('utf8').trim();
    return result.code === 0 && branch ? branch : null;
  }

  /** Imports a stage snapshot as a commit (idempotent) and returns its commit id. */
  async importStage(stage: number, files: readonly ArchiveFile[], message: string): Promise<string> {
    const tar = await writeTar(files);
    const { stdout } = await this.script('importStage', [String(stage), message], { input: tar, timeoutMs: 120_000 });
    return stdout.toString('utf8').trim().split('\n').at(-1)!;
  }

  async checkoutPlayerBranch(stage: number): Promise<void> {
    await this.script('checkoutPlayerBranch', [String(stage)], { timeoutMs: 60_000 });
  }

  async playerDiff(stage: number): Promise<string> {
    return (await this.script('playerDiff', [String(stage)], { timeoutMs: 60_000 })).stdout.toString('utf8');
  }

  async applyPatch(patch: string): Promise<void> {
    await this.exec(['git', 'apply', '--whitespace=nowarn', '-'], { input: patch, timeoutMs: 60_000 });
  }

  /** "<node version>\0<platform>\0<arch>" of the images, part of the dependency cache key. */
  private async runtime(): Promise<string> {
    this.runtimeKey ??= (
      await this.exec(['node', '-e', 'process.stdout.write(`${process.version}\\0${process.platform}\\0${process.arch}`)'])
    ).stdout.toString('utf8');
    return this.runtimeKey;
  }

  /** Same key as the QA CLI's --deps-cache: SHA-256 of the lockfile and the Node runtime. */
  async dependencyKey(): Promise<string | null> {
    const result = await this.docker.exec(this.names.container, ['cat', 'package-lock.json'], {
      user: 'node',
      workdir: WORKSPACE_DIR,
    });
    if (result.code !== 0) {
      return null;
    }
    return createHash('sha256').update(result.stdout).update(`\0${await this.runtime()}`).digest('hex');
  }

  async installedDependencyKey(): Promise<string | null> {
    const result = await this.docker.exec(this.names.container, ['cat', 'node_modules/.bugdetective-deps'], {
      user: 'node',
      workdir: WORKSPACE_DIR,
    });
    return result.code === 0 ? result.stdout.toString('utf8').trim() : null;
  }

  async cachedDependencies(key: string): Promise<boolean> {
    const result = await this.docker.exec(this.names.container, ['test', '-f', `${CACHE_DIR}/deps/${key}.tar`], { user: 'node' });
    return result.code === 0;
  }

  async installDependenciesFromCache(key: string, onLine?: RunOptions['onLine']): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(key)) {
      throw new Error('Invalid dependency key');
    }
    await this.script('installDepsFromCache', [key], { timeoutMs: 10 * 60_000, onLine });
  }

  async resetDatabase(onLine?: RunOptions['onLine']): Promise<void> {
    await this.exec(['npm', 'run', 'db:reset'], { timeoutMs: 120_000, onLine });
  }

  async isDevServerUp(): Promise<boolean> {
    const ports = await this.ports();
    if (!ports?.client) {
      return false;
    }
    try {
      const response = await fetch(`http://127.0.0.1:${ports.client}/`, { signal: AbortSignal.timeout(2000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  /** Starts `npm run dev` in the background inside the container, logging to /tmp/supportdesk-dev.log. */
  async startDevServer(): Promise<void> {
    await this.docker.checked([
      'exec',
      '--detach',
      '--user',
      'node',
      '--workdir',
      WORKSPACE_DIR,
      this.names.container,
      'sh',
      '-c',
      'exec npm run dev > /tmp/supportdesk-dev.log 2>&1',
    ]);
  }

  async bundle(): Promise<Buffer> {
    return (await this.script('bundle', [], { timeoutMs: 120_000 })).stdout;
  }

  async verifyBundle(bundle: Uint8Array): Promise<void> {
    await this.script('verifyBundle', [], { input: bundle, timeoutMs: 120_000 });
  }

  /** Restores the repository from a bundle into a fresh volume and checks out `branch`. */
  async restoreBundle(bundle: Uint8Array, branch: string): Promise<void> {
    await this.script('restoreBundle', [branch], { input: bundle, timeoutMs: 120_000 });
  }

  /** Removes the container and the workspace volume (used only by restore, after the player confirmed). */
  async destroy(): Promise<void> {
    await this.docker.removeContainer(this.names.container);
    await this.docker.removeVolume(this.names.volume);
  }
}
