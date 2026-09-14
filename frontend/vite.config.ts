import react from "@vitejs/plugin-react";
// 用 "vitest/config" 而不是 "vite" 的 defineConfig：前者是後者的型別超集，
// 讓下面的 test 區塊有型別檢查，不需要額外的 /// <reference types="vitest" />。
import { defineConfig } from "vitest/config";

// https://vite.dev/config/
export default defineConfig({
	plugins: [react()],
	server: {
		proxy: {
			// 規格決策 1：dev 也同源。瀏覽器看到的一律是 http://localhost:5173/api/...，
			// 由 Vite 轉給 localhost:8000 —— 所以 app 的程式碼裡永遠只寫相對路徑
			// "/api/..."，沒有任何地方需要知道後端在哪裡。
			//
			// 這也代表**不需要 CORS**：後端 app/main.py 沒有 CORSMiddleware，
			// 而同源之下也不該有。哪天有人為了「方便」在後端加 CORS，
			// 那是一個訊號：某個地方的同源假設破了。
			"/api": {
				target: "http://localhost:8000",
				changeOrigin: false,
			},
		},
	},
	test: {
		environment: "jsdom",
		setupFiles: ["./src/test/setup.ts"],
		globals: true,
	},
});
