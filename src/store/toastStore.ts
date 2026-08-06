/**
 * toastStore — KAN-149
 *
 * Global toast state. A single <Toast /> is mounted once at the App root
 * (sibling to the app shell) so the confirmation message survives the
 * New Task sheet closing or the More Details screen navigating back —
 * both of which unmount immediately after a successful add.
 *
 * Usage:
 *   import { useToastStore } from '../store/toastStore';
 *   useToastStore.getState().showToast("Got it — I'll keep an eye out.");
 */

import { create } from 'zustand';

export interface ToastAction {
  label: string;
  onPress: () => void;
}

interface ToastState {
  message: string | null;
  action: ToastAction | null;
  /** KAN-244 — an actionable toast (e.g. the coverage-invitation moment) needs longer to read + tap than a plain confirmation. */
  showToast: (message: string, action?: ToastAction) => void;
  hideToast: () => void;
}

export const useToastStore = create<ToastState>((set) => ({
  message: null,
  action: null,
  showToast: (message, action) => set({ message, action: action ?? null }),
  hideToast: () => set({ message: null, action: null }),
}));
