import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev`: the API port comes from the root .env (PORT, default 8787)
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '..', '');
  const apiPort = env.PORT || '8787';
  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: { '/api': { target: `http://127.0.0.1:${apiPort}`, changeOrigin: false } },
    },
  };
});
