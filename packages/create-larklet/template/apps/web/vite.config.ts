import react from '@vitejs/plugin-react';
import semiTheming from '@douyinfe/semi-vite-plugin';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [
    react(),
    semiTheming({ theme: '@semi-bot/semi-theme-universedesign' }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8788',
    },
  },
});
