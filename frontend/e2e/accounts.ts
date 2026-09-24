/** E2E 用的帳號。**角色是測試內容的一部分，不是巧合。**
 *
 *  兩個帳號由 CI 的「種子資料」步驟建立（`.github/workflows/ci.yml`），
 *  本機要自己跑一次（見 `docs/deployment.md`）。
 *
 *  **本機與 CI 曾經不一致過：** CI 一直用 `create-admin` 種
 *  `kenny.demo@example.com`，所以在 CI 它是管理員；而本機 dev 資料庫裡
 *  它是一般使用者。那個差異在 P3-B 計畫二之前沒有任何測試碰得到，
 *  所以也沒有人發現 —— 直到要寫「非管理員拿到 403」那條 E2E 才浮出來。
 */
export const ADMIN = {
	email: "kenny.demo@example.com",
	password: "demo-pass-12345",
} as const;

export const MEMBER = {
	email: "e2e.member@example.com",
	password: "member-pass-12345",
} as const;
