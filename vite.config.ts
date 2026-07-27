/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // En dev, l'API tourne à côté (npm run api) : même origine côté navigateur.
    proxy: {
      '/api': 'http://localhost:8787',
      // `ws: true` n'est pas décoratif : sans lui, Vite répond à l'upgrade par
      // un 400 et la WebSocket ne s'établit jamais en dev. On perdrait la
      // seule chose que ce jeu doit faire, et uniquement sur la machine du
      // développeur — le pire endroit pour découvrir le problème.
      '/ws': { target: 'http://localhost:8787', ws: true },
    },
  },
  test: {
    environment: 'node',
    // Le serveur a sa propre suite (`node --test`) : vitest ne regarde que le front.
    include: ['src/**/*.test.ts'],
  },
})
