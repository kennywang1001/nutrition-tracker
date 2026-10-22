import { useMutation } from "@tanstack/react-query";
import { ScanBarcode } from "lucide-react";
import { useRef, useState } from "react";
import {
	type BarcodePrefill,
	describeBarcodeError,
	lookupBarcode,
} from "../api/barcode";
import type { Food } from "../api/foods";
import styles from "./BarcodeScanEntry.module.css";
import { BarcodeScanner } from "./BarcodeScanner";

/** 同 `FoodPicker` 的那一句：沒有生效版本的食物記不了（`POST /api/meals` 回 409）。 */
const NO_REVISION_MESSAGE = "這個食物還沒有生效的營養素資料";

type Props = {
	/** 命中。`requireNutrition` 時沒有生效版本的食物不會走到這裡（畫面說明它不能選）。 */
	onFood: (food: Food) => void;
	/** 沒命中時的「用這個條碼建立食物」；不給就只說找不到。`code` 是後端回的標準形式。 */
	onCreate?: (code: string, prefill: BarcodePrefill | null) => void;
	requireNutrition?: boolean;
	/** 一掛載就打開掃描層（總覽的「掃條碼」，首頁改版規格 D9）。只在掛載時讀。掃描層自己把焦點放在「取消」；
	 *  「取消」之後焦點回到這裡的「掃條碼」，再按一次就是使用者手勢。 */
	startScanning?: boolean;
};

type Outcome =
	| { kind: "idle" }
	| { kind: "miss"; code: string; prefill: BarcodePrefill | null }
	| { kind: "no-nutrition"; name: string }
	| { kind: "error"; message: string };

/** Open Food Facts 的出處（ODbL 要求標示，掃條碼規格 D23、§6.4）。畫面上出現 OFF 資料的地方一律用它。 */
export function OffAttribution() {
	return (
		<p className={styles.attribution}>
			資料來源：
			<a
				href="https://world.openfoodfacts.org"
				target="_blank"
				rel="noreferrer"
			>
				Open Food Facts
			</a>
			（ODbL）
		</p>
	);
}

/** 「掃條碼」的入口＋查詢＋沒命中的卡片（掃條碼規格 D18、D19）。記一餐、編輯這一餐的「加一項」
 *  （都在 `FoodPicker` 裡）與食物庫共用。
 *
 *  - 命中就交出去，跟從搜尋結果選一樣；**沒命中不自動跳頁**：記一餐裡已經填的東西會因為換頁消失，
 *    讓人自己按「用這個條碼建立食物」。
 *  - 狀態那一行（`role="status"`）一直在畫面上、只換文字：螢幕閱讀器才唸得到「查詢中…」與結果
 *    （一插入就帶著文字的 live region 常常不唸）。
 *  - 查詢中「掃條碼」用 `aria-disabled`＋擋在 onClick：掃描層關掉之後焦點就在它身上，原生停用會把
 *    焦點丟到 body。 */
export function BarcodeScanEntry({
	onFood,
	onCreate,
	requireNutrition,
	startScanning,
}: Props) {
	const [scanning, setScanning] = useState(startScanning === true);
	const [outcome, setOutcome] = useState<Outcome>({ kind: "idle" });
	const triggerRef = useRef<HTMLButtonElement>(null);
	const lookup = useMutation({ mutationFn: lookupBarcode });
	const busy = lookup.isPending;

	function closeScanner() {
		setScanning(false);
		triggerRef.current?.focus();
	}

	function handleCode(code: string) {
		closeScanner();
		// 回應放在 mutate 的第二個參數：元件卸載之後（使用者已經離開）不交出食物（handover §7）。
		lookup.mutate(code, {
			onSuccess: (result) => {
				if (result.food === null) {
					setOutcome({
						kind: "miss",
						code: result.code,
						prefill: result.prefill,
					});
					return;
				}
				if (requireNutrition && result.food.nutrition === null) {
					setOutcome({ kind: "no-nutrition", name: result.food.name });
					return;
				}
				setOutcome({ kind: "idle" });
				onFood(result.food);
			},
			onError: (error) =>
				setOutcome({ kind: "error", message: describeBarcodeError(error) }),
		});
	}

	let statusText = "";
	if (busy) statusText = "查詢中…";
	else if (outcome.kind === "miss")
		statusText = `找不到這個條碼（${outcome.code}）`;
	else if (outcome.kind === "no-nutrition")
		statusText = `${outcome.name}：${NO_REVISION_MESSAGE}`;

	return (
		<div className={styles.entry}>
			<div className={styles.row}>
				<button
					ref={triggerRef}
					type="button"
					className={styles.scan}
					aria-disabled={busy}
					onClick={() => {
						if (busy) return;
						setOutcome({ kind: "idle" });
						setScanning(true);
					}}
				>
					<ScanBarcode aria-hidden="true" size={18} />
					掃條碼
				</button>
				<p className={styles.note}>
					查不到時，條碼可能會送到 Open Food Facts 查詢
				</p>
			</div>

			<section
				aria-label={
					outcome.kind === "miss" && !busy ? "找不到這個條碼" : undefined
				}
				className={
					outcome.kind === "miss" && !busy ? styles.card : styles.quiet
				}
			>
				<p role="status" className={styles.status}>
					{statusText}
				</p>
				{outcome.kind === "miss" && !busy && (
					<>
						{outcome.prefill !== null && (
							<>
								<p>
									Open Food Facts 有這個商品：
									{outcome.prefill.name ?? "（沒有名稱）"}
								</p>
								<OffAttribution />
							</>
						)}
						{onCreate !== undefined && (
							<button
								type="button"
								className={styles.create}
								onClick={() => onCreate(outcome.code, outcome.prefill)}
							>
								用這個條碼建立食物
							</button>
						)}
					</>
				)}
			</section>

			{outcome.kind === "error" && !busy && (
				<p role="alert" className={styles.error}>
					{outcome.message}
				</p>
			)}

			{scanning && (
				<BarcodeScanner onCode={handleCode} onCancel={closeScanner} />
			)}
		</div>
	);
}
