/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PROXY_BASE?: string;
  readonly VITE_DATA_BASE_URL?: string;
  readonly VITE_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv & { readonly BASE_URL: string };
}
