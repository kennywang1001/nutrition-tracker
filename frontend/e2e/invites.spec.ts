import { expect, test } from "@playwright/test";
import { expectTouchTargets, login } from "./touch-targets.ts";

const PHONE = { width: 390, height: 844 };

test.use({ viewport: PHONE });

test("管理員產生邀請連結，朋友用它開帳號；同一個連結不能再用", async ({
	page,
	browser,
}) => {
	await login(page);
	await page.goto("/me");
	await expect(page.getByRole("heading", { name: "邀請朋友" })).toBeVisible();

	const note = `E2E 邀請 ${Date.now()}`;
	await page.getByLabel("給誰？（選填）").fill(note);
	await page.getByRole("button", { name: "產生邀請連結" }).click();
	const link = await page.getByLabel("邀請連結", { exact: true }).inputValue();
	expect(link).toContain("/join#");
	await expectTouchTargets(
		page.locator("main button:visible"),
		"我的：邀請朋友",
	);

	// 朋友：一個完全沒登入過的瀏覽器。
	const friend = await browser.newContext({ viewport: PHONE });
	const friendPage = await friend.newPage();
	await friendPage.goto(link);
	await expect(friendPage.getByLabel("再輸入一次密碼")).toBeVisible();
	await expectTouchTargets(friendPage.locator("button:visible"), "建立帳號");

	const email = `e2e.friend.${Date.now()}@example.com`;
	await friendPage.getByLabel("Email").fill(email);
	await friendPage.getByLabel("名字").fill("E2E 朋友");
	await friendPage
		.getByLabel("密碼", { exact: true })
		.fill("friend-pass-12345");
	await friendPage.getByLabel("再輸入一次密碼").fill("friend-pass-12345");
	await friendPage.getByRole("button", { name: "建立帳號" }).click();

	await expect(friendPage.getByRole("heading", { name: "總覽" })).toBeVisible();
	expect(new URL(friendPage.url()).hash).toBe("");
	await friend.close();

	// 同一個連結：另一個沒登入的瀏覽器打開 → 失效。
	const stranger = await browser.newContext({ viewport: PHONE });
	const strangerPage = await stranger.newPage();
	await strangerPage.goto(link);
	await expect(
		strangerPage.getByText("這個邀請連結已經失效，請跟邀請你的人要一個新的"),
	).toBeVisible();
	await expect(
		strangerPage.getByRole("button", { name: "建立帳號" }),
	).toHaveCount(0);
	await stranger.close();

	// 管理員的清單：重新整理之後，這一張出現在「已經用掉的」，寫著朋友的 email。
	// 快取會持久化、app 預設 staleTime 60 秒——清單要自己每次重抓
	// （`useInvites` 的 staleTime: 0），否則這裡看到的是 reload 之前的舊清單。
	await page.reload();
	await expect(page.getByText(`E2E 朋友（${email}）`)).toBeVisible();
});
