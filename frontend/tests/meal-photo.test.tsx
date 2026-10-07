import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useMealPhoto } from "../src/api/photos";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { MealList } from "../src/screens/MealList";
import { json, mockApiByPath as mockApi } from "./helpers/mock-api";

// QueryWrapper 從 today.test.tsx 的 wrap 改寫——`renderHook` 的 `wrapper`
// 選項要的是一個接受 `children` 的元件，不是 `wrap()` 那樣直接回一段 JSX
// 的函式。`retry: false` 跟 `wrap()` 同一個理由：測試裡的假失敗不該被
// TanStack Query 的預設重試拖慢或蓋掉。

function QueryWrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("useMealPhoto", () => {
	it("帶著 Authorization 取圖", async () => {
		const fetchMock = mockApi({
			"/api/meals/11/photo": () =>
				new Response(new Blob(["fake-jpeg"], { type: "image/jpeg" }), {
					status: 200,
					headers: { "content-type": "image/jpeg" },
				}),
		});

		const { result } = renderHook(() => useMealPhoto(11), {
			wrapper: QueryWrapper,
		});
		await waitFor(() => expect(result.current.objectUrl).not.toBeNull());

		const call = fetchMock.mock.calls.find(([input]) =>
			String(input).includes("/photo"),
		);
		expect(new Headers(call?.[1]?.headers).get("authorization")).toBe(
			"Bearer a",
		);
	});

	it("卸載時釋放 object URL", async () => {
		// **沒有這條測試，這個洩漏永遠不會有人發現。**
		// 每一個 createObjectURL 都在文件的生命週期裡佔著那個 blob，
		// 直到 revoke 或整頁關掉。清單頁滑動幾十張照片之後，
		// 手機上的分頁會被系統殺掉——而那看起來像「app 很爛」，
		// 不像「有一行 revokeObjectURL 沒寫」。
		const revoke = vi.spyOn(URL, "revokeObjectURL");
		mockApi({
			"/api/meals/11/photo": () =>
				new Response(new Blob(["fake-jpeg"], { type: "image/jpeg" }), {
					status: 200,
				}),
		});

		const { result, unmount } = renderHook(() => useMealPhoto(11), {
			wrapper: QueryWrapper,
		});
		await waitFor(() => expect(result.current.objectUrl).not.toBeNull());
		const url = result.current.objectUrl;

		unmount();

		expect(revoke).toHaveBeenCalledWith(url);
	});

	it("404 時 objectUrl 是 null，不是壞掉的 URL", async () => {
		// DB 有 photo_path 但檔案不在磁碟上，是後端正常操作下可達的狀態
		// （delete_photo 是 best-effort），後端會回 404 MEAL_PHOTO_NOT_FOUND。
		mockApi({
			"/api/meals/11/photo": () =>
				new Response(
					JSON.stringify({
						error: {
							code: "MEAL_PHOTO_NOT_FOUND",
							message: "這一餐沒有照片",
							details: {},
						},
					}),
					{ status: 404, headers: { "content-type": "application/json" } },
				),
		});

		const { result } = renderHook(() => useMealPhoto(11), {
			wrapper: QueryWrapper,
		});

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(result.current.objectUrl).toBeNull();
	});
});

describe("餐點卡片的照片", () => {
	it("卡片要的是縮圖，點了才抓原圖", async () => {
		const fetchMock = mockApi({
			"/api/meals/11/photo": () =>
				new Response(new Blob(["fake-jpeg"], { type: "image/jpeg" }), {
					status: 200,
				}),
			"/api/meals": () =>
				json([
					{
						id: 11,
						eaten_at: "2026-09-21T12:30:00+08:00",
						meal_type: "lunch",
						note: null,
						photo_path: "3/abc123.jpg",
						items: [],
						kcal: "0.00",
						protein_g: "0.00",
						fat_g: "0.00",
						carb_g: "0.00",
					},
				]),
		});
		const urls = () => fetchMock.mock.calls.map(([url]) => String(url));
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});

		render(
			<QueryClientProvider client={client}>
				<MemoryRouter>
					<MealList />
				</MemoryRouter>
			</QueryClientProvider>,
		);
		const trigger = await screen.findByRole("button", { name: /^看大圖：/ });

		expect(
			urls().some((u) => u.endsWith("/api/meals/11/photo?size=thumb")),
		).toBe(true);
		expect(urls().some((u) => u.endsWith("/api/meals/11/photo"))).toBe(false);

		await userEvent.click(trigger);

		await waitFor(() =>
			expect(urls().some((u) => u.endsWith("/api/meals/11/photo"))).toBe(true),
		);
	});
});
