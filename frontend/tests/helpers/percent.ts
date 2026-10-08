/** 畫面上的百分比文字，用跟畫面一樣的格式算出來（MacroBar、CategoryBar、
 *  趨勢頁的依從率都是 `toLocaleString(undefined, { style: "percent",
 *  maximumFractionDigits: 0 })`）。
 *
 *  不寫死 "200%"：locale 是 undefined，跑測試那台機器的語系決定長相——
 *  例如法文是「200 %」（中間是窄的不換行空白），寫死的話換一台機器就紅，
 *  而 `not.toHaveTextContent("0%")` 這種反向斷言更糟：會在別的語系下空轉綠。
 *
 *  空白壓成一個半形空白：jest-dom 的 toHaveTextContent 比對前會把畫面文字的
 *  `\s+` 換成一個空白，期望值也要做一樣的事才對得上。 */
export function percentText(ratio: number): string {
	return ratio
		.toLocaleString(undefined, { style: "percent", maximumFractionDigits: 0 })
		.replace(/\s+/g, " ");
}
