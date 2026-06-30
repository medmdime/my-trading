import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, loadEnv } from "vite"

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // loadEnv with "" prefix reads ALL vars (incl. non-VITE_ ones).
  // We deliberately keep API_USER / API_PASS / API_TARGET WITHOUT the VITE_
  // prefix so they stay server-side (Vite proxy only) and are never bundled
  // into the browser. The browser talks to the dev server's /api and /ws,
  // and this proxy injects Basic auth on the way out.
  const env = loadEnv(mode, process.cwd(), "")
  const API_TARGET = env.API_TARGET || "https://api.stylette.info"
  const WS_TARGET = API_TARGET.replace(/^http/, "ws")
  const user = env.API_USER || "admin"
  const pass = env.API_PASS || "admin"
  const basic = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64")

  return {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      proxy: {
        // REST: browser /api/portfolio/state -> {API_TARGET}/portfolio/state
        "/api": {
          target: API_TARGET,
          changeOrigin: true,
          secure: false,
          rewrite: (p) => p.replace(/^\/api/, ""),
          configure: (proxy) => {
            proxy.on("proxyReq", (proxyReq) => {
              proxyReq.setHeader("Authorization", basic)
            })
          },
        },
        // WebSocket: browser /ws/executors -> {WS_TARGET}/ws/executors
        "/ws": {
          target: WS_TARGET,
          changeOrigin: true,
          secure: false,
          ws: true,
          configure: (proxy) => {
            // Inject Basic auth on the WS upgrade request.
            proxy.on("proxyReqWs", (proxyReq) => {
              proxyReq.setHeader("Authorization", basic)
            })
          },
        },
      },
    },
  }
})
