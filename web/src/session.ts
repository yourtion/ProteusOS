export interface SessionStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
/** Optional browser persistence must not break task execution or rendering. */
export function safeStorage(access: () => SessionStore | undefined): SessionStore {
  return {
    getItem(key) {
      try {
        return access()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    setItem(key, value) {
      try {
        access()?.setItem(key, value);
      } catch {
        /* Memory state remains authoritative. */
      }
    },
    removeItem(key) {
      try {
        access()?.removeItem(key);
      } catch {
        /* Storage can be unavailable in restricted contexts. */
      }
    },
  };
}
export const browserSession = safeStorage(
  () => (globalThis as { sessionStorage?: SessionStore }).sessionStorage,
);
