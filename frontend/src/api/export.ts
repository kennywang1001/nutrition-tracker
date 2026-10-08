import { fetchDownload } from "./client";

/** 可以匯出的三種資料（報表月份與匯出規格 §3）。`kind` 就是端點的檔名：
 *  `GET /api/export/{kind}.csv`。 */
export const EXPORT_KINDS = [
	{ kind: "meals", label: "餐點" },
	{ kind: "expenses", label: "花費" },
	{ kind: "supplements", label: "補劑" },
] as const;

export type ExportKind = (typeof EXPORT_KINDS)[number]["kind"];

/** 下載一種資料的全部歷史。檔名用後端給的（帶後端算的「今天」——前端不自己算
 *  日期）；後端沒給就退回不帶日期的 `{kind}.csv`。 */
export async function downloadExport(
	kind: ExportKind,
): Promise<{ blob: Blob; filename: string }> {
	const { blob, filename } = await fetchDownload(`/api/export/${kind}.csv`);
	return { blob, filename: filename ?? `${kind}.csv` };
}
