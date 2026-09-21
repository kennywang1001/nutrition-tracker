import "@testing-library/jest-dom/vitest";

// jsdom（目前鎖的版本，29.x）沒有實作 URL.createObjectURL /
// URL.revokeObjectURL —— 它有 Blob/File，但沒有「object URL 註冊表」
// 那一塊（實測過：直接 new JSDOM() 之後 typeof window.URL.createObjectURL
// 是 "undefined"）。`useMealPhoto`（計畫三 Task 2）依賴這兩個 API，
// 而且 `tests/meal-photo.test.tsx` 用 `vi.spyOn(URL, "revokeObjectURL")`
// ——spyOn 需要那個屬性本來就是一個函式才能包裝，所以這裡不能什麼都不做。
//
// 用一個遞增計數器產生穩定、彼此不同的假 blob: URL；revoke 什麼都不做，
// 純粹是讓 spyOn 有東西可以包、讓測試能斷言「有沒有被呼叫、呼叫時的參數
// 是不是當初那個 URL」——不是要模擬瀏覽器真的釋放記憶體這件事。
if (typeof URL.createObjectURL !== "function") {
	let counter = 0;
	URL.createObjectURL = (_obj: Blob | MediaSource) => {
		counter += 1;
		return `blob:mock-${counter}`;
	};
}
if (typeof URL.revokeObjectURL !== "function") {
	URL.revokeObjectURL = (_url: string) => {
		// 沒有真的物件 URL 註冊表可以清——見上面的說明。
	};
}
