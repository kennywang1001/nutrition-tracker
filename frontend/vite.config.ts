import react from "@vitejs/plugin-react";
// 用 "vitest/config" 而不是 "vite" 的 defineConfig：前者是後者的型別超集，
// 讓下面的 test 區塊有型別檢查，不需要額外的 /// <reference types="vitest" />。
import { defineConfig } from "vitest/config";

// https://vite.dev/config/
export default defineConfig({
	plugins: [react()],
	test: {
		environment: "jsdom",
		setupFiles: ["./src/test/setup.ts"],
		globals: true,
	},
});
