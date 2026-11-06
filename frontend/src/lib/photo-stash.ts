/** 一張照片從一頁帶到下一頁：總覽的「拍照記」→ 記一餐（首頁改版規格 D8）、「拍營養標示」→ 新增食物
 *  （改名規格 D3）。**`File` 不放進 history**：`history.state` 會被結構化複製（Firefox 有大小上限），
 *  重新整理還會把舊照片帶回來。state 只帶號碼，檔案留在這個模組的記憶體裡、一次只留一張——重新整理
 *  （模組重新載入）就沒有了，刻意。一格就夠：一次只會有一張照片在路上。 */
let stash: { id: number; file: File } | null = null;
let nextId = 1;

export function stashPhoto(file: File): number {
	const id = nextId;
	nextId += 1;
	stash = { id, file };
	return id;
}

/** 號碼對得上才回檔案：舊的 history（上一頁回到更早的那一頁）帶著舊號碼，換不到後來那一張。
 *  **讀了不清掉**：`useState` 的初值函式在 StrictMode 會被呼叫兩次，清掉的話其中一次拿到 null。
 *  清的時機是接手的那一頁清 history 的 state 那一刻（`releaseStashedPhoto`）。 */
export function stashedPhoto(id: unknown): File | null {
	return typeof id === "number" && stash !== null && stash.id === id
		? stash.file
		: null;
}

/** 放掉暫存的照片（已經交給下一頁自己的 state）：不留著一張可能好幾 MB 的檔案。 */
export function releaseStashedPhoto(): void {
	stash = null;
}
