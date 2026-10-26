import type { Platform } from './types.ts';
import { createWindowsPlatform } from './windows.ts';

export type { Platform } from './types.ts';

/** The platform implementation for this OS. Only Windows is supported for now. */
export function currentPlatform(): Platform {
  if (process.platform === 'win32') {
    return createWindowsPlatform();
  }
  throw new Error(`Bug Detective does not support ${process.platform} yet. Only Windows is supported for now.`);
}
