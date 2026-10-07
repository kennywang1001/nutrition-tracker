import type { components } from "../api/schema";
import { formatCivilDate } from "../lib/civil-date";
import { formatMacro, maxOf, ratioOf } from "../lib/decimal";

export type TrendDay = components["schemas"]["DayTrendResponse"];

/** 趨勢圖可以畫的四項（介面改版第二階段 §5）。跟 `MacrosResponse` 的欄位同名。 */
export type TrendMetric = "kcal" | "protein_g" | "fat_g" | "carb_g";

/** 每一項的名稱與單位。`spokenUnit` 是 aria-label 用的（螢幕閱讀器念「大卡」
 *  「克」比念「kcal」「g」自然）；熱量的 label 刻意維持原本的格式
 *  （「9/15，1800 大卡，…」，既有測試釘著）。 */
export const TREND_METRICS: Record<
	TrendMetric,
	{ label: string; unit: string; spokenUnit: string }
> = {
	kcal: { label: "熱量", unit: "kcal", spokenUnit: "大卡" },
	protein_g: { label: "蛋白質", unit: "g", spokenUnit: "克" },
	fat_g: { label: "脂肪", unit: "g", spokenUnit: "克" },
	carb_g: { label: "碳水", unit: "g", spokenUnit: "克" },
};

export const TREND_METRIC_ORDER: readonly TrendMetric[] = [
	"kcal",
	"protein_g",
	"fat_g",
	"carb_g",
];

/** SVG 的座標系。**固定值，不量容器** —— jsdom 不做版面計算，
 *  任何依賴實際寬度的東西在測試裡都會讀到 0。用 viewBox + preserveAspectRatio
 *  讓瀏覽器自己縮放，程式碼裡的座標永遠是這組數字。 */
const VIEW_WIDTH = 280;
const VIEW_HEIGHT = 160;
/** 柱子下方給日期用的一條。柱子的計算範圍仍然是 VIEW_HEIGHT——
 *  既有的高度比例與位置測試不受影響。 */
const DATE_BAND = 16;
const BAR_WIDTH_RATIO = 0.6;
/** 超過這個天數，日期軸就不是每根都標（趨勢期間規格 §2）。 */
const LABEL_EVERY_BAR_UP_TO = 7;
/** 天數多的時候，從最後一根（今天）往回每幾根標一次。 */
const LABEL_STRIDE = 7;

/** 第 `index` 根（共 `count` 根）下面要不要寫日期。
 *
 *  7 天以內每根都標。超過 7 天（30 天時柱寬約 9 個單位，放不下 30 個
 *  「9/15」）只標最後一根與往回每 7 根——從尾端數，所以今天一定有標，
 *  而且標到的那幾天都跟今天同一個星期幾。
 *  沒標的柱子 aria-label 照樣有日期；日期軸本來就是裝飾。 */
function hasDateLabel(index: number, count: number): boolean {
	if (count <= LABEL_EVERY_BAR_UP_TO) return true;
	return (count - 1 - index) % LABEL_STRIDE === 0;
}

/** 最近幾天的營養素長條圖（規格 §4.4–§4.6）。
 *
 *  **純渲染，不取資料。** 呼叫端負責查詢、載入中、錯誤。
 *
 *  ## 幾何一律算成屬性，不交給 CSS
 *
 *  `height`、`y` 都是在這裡算好寫進 SVG 屬性的。**不可以改成用 CSS 控制
 *  柱子高度** —— jsdom 不做版面計算，`getBoundingClientRect()` 回 0，
 *  規格 §4.6 那條「高度比例等於數值比例」的斷言就會退化成在比兩個空值。
 *
 *  ## 兩層 null
 *
 *  `target` 整個是 `null`（那天沒有生效目標）與 `target[metric]` 是 `null`
 *  （有目標但這一項沒設）是**兩個不同的事實**，雖然畫面結果都是不畫目標線。
 *  **不要寫成 `day.target?.[metric] ?? 0`** —— 那會把兩層壓成一層，然後畫出
 *  一條貼地的線，讀起來是「今天的目標是 0 大卡」。
 *
 *  ## `role="img"` 是必要的，Biome 那兩條規則在這裡是誤判
 *
 *  Biome 的 `a11y/useSemanticElements`（建議把 `<svg role="group">` 換成
 *  `<fieldset>`）與 `a11y/noInteractiveElementToNoninteractiveRole`
 *  （把 `<rect>` 當成互動元素）會擋下這個寫法。兩條在這裡都不成立：
 *  `<rect>` 不是互動元素，`<svg>` 也不該變成 `<fieldset>`。
 *
 *  **不能為了讓 lint 過就把 `role` 拿掉。** 實測過（`tests/trend-chart.test.tsx`
 *  的「每根柱子都是一個可以按角色找到的 img」那條）：
 *
 *  | 寫法 | `getAllByRole("img")` |
 *  |---|---|
 *  | `<rect aria-label="…">` | **找不到** |
 *  | `<rect role="img" aria-label="…">` | 找到 |
 *
 *  `aria-label` 放在沒有語意角色的元素上，輔助技術多半直接忽略它 ——
 *  SVG 的 `<rect>` 預設不對應任何 accessible role。所以拿掉 `role` 等於
 *  把這張圖對螢幕閱讀器的可讀性整個拿掉，而**既有測試全部用
 *  `getByTestId`，一條都不會紅**。
 *
 *  （`<title>` 子元素那條路也試過：jsdom 裡 `getByTitle` 找不到它，
 *  所以在這個測試環境下無法驗證，不採用。）
 *
 *  這件事在實作時真的發生過一次 —— 那是 `alt=""` 那一課的同一個形狀：
 *  **測試查得到的那個東西，跟使用者（或螢幕閱讀器）拿得到的那個東西，
 *  必須真的是同一個。** 所以現在有一條測試專門斷言 `role`。
 */
type Props = {
	days: readonly TrendDay[];
	/** 要畫哪一項。預設熱量——既有的呼叫端與測試都是熱量。 */
	metric?: TrendMetric;
	/** 今天的日期（`stats/daily` 回的 `date`）。那一根畫淡色——今天還沒結束。
	 *  **圖表不自己算今天**（前端不算日界線），由畫面傳進來。 */
	today?: string | null;
};

export function TrendChart({ days, metric = "kcal", today = null }: Props) {
	// y 軸上限：期間內實際值與目標值的最大值。目標可能整組是 null，
	// 也可能這一項是 null——兩種都不參與比較。
	const targetValues = days
		.map((day) => day.target?.[metric] ?? null)
		.filter((value): value is string => value !== null);
	const ceiling = maxOf([
		...days.map((day) => day.actual[metric]),
		...targetValues,
	]);

	const slot = VIEW_WIDTH / Math.max(days.length, 1);
	const barWidth = slot * BAR_WIDTH_RATIO;
	const inset = (slot - barWidth) / 2;

	/** 把一個數值換算成 SVG 的 y 座標。
	 *
	 *  `ratioOf` 在 ceiling 是 "0" 時回 `null`（除以 0 沒有意義），
	 *  這裡把它當成「高度 0」—— 規格 §4.5（三）：全都是 0 又沒目標的期間，
	 *  所有柱子貼地，不是炸掉。 */
	const heightOf = (value: string): number => {
		const ratio = ratioOf(value, ceiling);
		return ratio === null ? 0 : ratio * VIEW_HEIGHT;
	};

	return (
		// biome-ignore lint/a11y/useSemanticElements: 它建議的替代品是 <fieldset>，對一張 SVG 圖表沒有意義
		<svg
			viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT + DATE_BAND}`}
			className="trend-chart"
			data-testid="trend-chart"
			role="group"
			aria-label={`最近幾天的${TREND_METRICS[metric].label}`}
		>
			{days.map((day, index) => {
				const height = heightOf(day.actual[metric]);
				const x = index * slot + inset;
				// 第一層 null（整天沒目標）與第二層 null（這一項沒設）在這裡
				// 一起被收斂成「沒有可畫的目標值」——但收斂發生在讀完兩層之後，
				// 不是用 ?? 0 把它們壓成同一個數字。
				const targetValue = day.target === null ? null : day.target[metric];
				const { spokenUnit } = TREND_METRICS[metric];
				// 熱量維持原本的格式（「9/15，1800 大卡，…」）；其他項目前面多寫
				// 項目名稱——「50 克」單獨念出來聽不出是哪一項。
				const what = metric === "kcal" ? "" : `${TREND_METRICS[metric].label} `;
				const value = `${what}${formatMacro(day.actual[metric])} ${spokenUnit}`;
				const label =
					targetValue === null
						? `${formatCivilDate(day.date)}，${value}，沒有目標`
						: `${formatCivilDate(day.date)}，${value}，目標 ${formatMacro(targetValue)} ${spokenUnit}`;

				return (
					<g key={day.date}>
						{/* biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: rect 不是互動元素，這是規則的誤判；拿掉 role 會讓柱子對螢幕閱讀器消失，見檔頭說明 */}
						<rect
							data-testid={`trend-bar-${day.date}`}
							role="img"
							aria-label={label}
							x={x}
							y={VIEW_HEIGHT - height}
							width={barWidth}
							height={height}
							rx={3}
							className={
								day.date === today ? "trend-bar trend-bar-today" : "trend-bar"
							}
						/>
						{hasDateLabel(index, days.length) && (
							// biome-ignore lint/a11y/noAriaHiddenOnFocusable: SVG <text> 不能聚焦，這是規則的誤判；日期是裝飾，柱子的 aria-label 已經有
							<text
								data-testid={`trend-date-${day.date}`}
								x={x + barWidth / 2}
								y={VIEW_HEIGHT + DATE_BAND - 4}
								textAnchor="middle"
								className="trend-date"
								aria-hidden="true"
							>
								{day.date === today ? "今天" : formatCivilDate(day.date)}
							</text>
						)}
						{targetValue !== null && (
							<line
								data-testid={`trend-target-${day.date}`}
								x1={index * slot}
								x2={(index + 1) * slot}
								y1={VIEW_HEIGHT - heightOf(targetValue)}
								y2={VIEW_HEIGHT - heightOf(targetValue)}
								className="trend-target"
							/>
						)}
					</g>
				);
			})}
		</svg>
	);
}
