import { createContext, useContext } from 'react';

export interface ToastApi {
  info(text: string): void;
  error(error: unknown): void;
}

export const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error('useToast outside ToastProvider');
  }
  return context;
}
