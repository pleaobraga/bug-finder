import { createLinuxPlatform } from './linux.ts';
import type { Platform } from './types.ts';
import { createWindowsPlatform } from './windows.ts';

export type { Platform } from './types.ts';

/** The platform implementation for this OS: Windows, or Linux (including WSL 2). */
export function currentPlatform(): Platform {
  if (process.platform === 'win32') {
    return createWindowsPlatform();
  }
  if (process.platform === 'linux') {
    return createLinuxPlatform();
  }
  throw new Error(`Bug Detective does not support ${process.platform} yet.`);
}
