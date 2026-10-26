/** The stage manifest written by tools/build-stage-packages and checked by every content source. */
import { z } from 'zod';

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const stageEntrySchema = z.object({
  stage: z.number().int().min(1).max(99),
  branch: z.string().regex(/^stage-\d+$/),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  commitMessage: z.string().max(200),
  /** treeDigest of the stage branch files. */
  codeDigest: digest,
  codeFiles: z.number().int().positive(),
  package: z.object({
    file: z.string().regex(/^[A-Za-z0-9._-]+\.zip$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    size: z.number().int().positive(),
    /** treeDigest of the files inside the package. */
    digest,
  }),
});

export const manifestSchema = z.object({
  format: z.literal('bug-detective-stages'),
  formatVersion: z.literal(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  createdAt: z.string(),
  stages: z.array(stageEntrySchema).min(1),
});

export type StageEntry = z.infer<typeof stageEntrySchema>;
export type StageManifest = z.infer<typeof manifestSchema>;

export class ContentVerificationError extends Error {}

export function parseManifest(json: unknown): StageManifest {
  const result = manifestSchema.safeParse(json);
  if (!result.success) {
    throw new ContentVerificationError(`Invalid stage manifest: ${result.error.issues[0]?.message ?? 'unknown error'}`);
  }
  return result.data;
}

export function stageEntry(manifest: StageManifest, stage: number): StageEntry {
  const entry = manifest.stages.find((item) => item.stage === stage);
  if (!entry) {
    throw new ContentVerificationError(`Stage ${stage} is not in the manifest`);
  }
  return entry;
}

/** Files of the authoring folder that never go into a player's stage package. */
export const PACKAGE_EXCLUDED = new Set(['bug.patch']);
