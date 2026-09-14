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
		// 讓 expectTypeOf 真的被檢查，而不是一個永遠通過的 no-op。
		// Vitest 5 的 typecheck.include 預設只認 *.test-d.ts，我們把型別層
		// 測試跟一般測試放在同一個 *.test.ts 檔案裡，所以要覆寫成同一個
		// glob——這樣同一支檔案會被跑兩次：一次當一般測試執行，一次交給
		// tsc 做型別檢查（`npm run test` 就會觸發，不需要額外的 CLI flag）。
		//
		// tsconfig 必須明講：不指定的話 vitest 會找到 frontend/tsconfig.json
		// ——那份只是 project references 的殼（"files": []、沒有自己的
		// compilerOptions），不是 tsconfig.app.json 那份有 strict、有
		// include: ["src","tests"] 的實際設定。實測過：不指定時，把
		// schema.d.ts 的 protein_g 從 string 改成 number，typecheck 還是
		// 全線通過——是假綠燈。指到 tsconfig.app.json 之後同一個突變才會紅。
		typecheck: {
			enabled: true,
			tsconfig: "./tsconfig.app.json",
			include: ["tests/**/*.test.ts"],
		},
	},
});
