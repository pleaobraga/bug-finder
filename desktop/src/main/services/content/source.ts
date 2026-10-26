/** The content source interface and the checksum verification shared by every source. */
import type { ArchiveFile } from './archive.ts';
import { sha256Hex, treeDigest } from './archive.ts';
import { ContentVerificationError } from './manifest.ts';
import type { StageEntry } from './manifest.ts';

export interface FetchedStage {
  entry: StageEntry;
  /** The stage package zip, exactly as described by the manifest. */
  packageZip: Uint8Array;
  packageFiles: ArchiveFile[];
  /** The files of the stage branch. */
  codeFiles: ArchiveFile[];
}

export interface ContentSource {
  readonly kind: 'local' | 'github';
  /** Human-readable origin, for Settings and logs. */
  describe(): string;
  /** Fetches and verifies one stage. Throws ContentVerificationError on any checksum mismatch. */
  fetchStage(stage: number, signal?: AbortSignal): Promise<FetchedStage>;
}

/** Checks the package zip bytes before they are even parsed. */
export function verifyPackageZip(entry: StageEntry, zip: Uint8Array): Uint8Array {
  if (zip.length !== entry.package.size || sha256Hex(zip) !== entry.package.sha256) {
    throw new ContentVerificationError(`Stage ${entry.stage}: the package checksum does not match the manifest`);
  }
  return zip;
}

/** Verifies a fetched stage against its manifest entry. Nothing is used before this passes. */
export function verifyStage(stage: FetchedStage): FetchedStage {
  const { entry } = stage;
  verifyPackageZip(entry, stage.packageZip);
  if (treeDigest(stage.packageFiles) !== entry.package.digest) {
    throw new ContentVerificationError(`Stage ${entry.stage}: the package contents do not match the manifest`);
  }
  if (stage.codeFiles.length !== entry.codeFiles || treeDigest(stage.codeFiles) !== entry.codeDigest) {
    throw new ContentVerificationError(`Stage ${entry.stage}: the stage code does not match the manifest`);
  }
  return stage;
}
