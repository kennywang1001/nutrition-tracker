import { Link } from "react-router";
import { type BodyProfile, useBodyProfile } from "../api/body";
import { ACTIVITY_OPTIONS, GOAL_OPTIONS, SEX_OPTIONS } from "../lib/body";
import { formatMacro } from "../lib/decimal";
import styles from "./BodyProfileCard.module.css";
import { Card } from "./Card";
import ui from "./ui.module.css";

/** 「減重每週 0.5 公斤」「維持體重」；沒有速度只寫「減重」。 */
function goalText(profile: BodyProfile): string | undefined {
	const goal = profile.goal ?? null;
	if (goal === null) return undefined;
	if (goal === "maintain") return "維持體重";
	const label = GOAL_OPTIONS.find((option) => option.value === goal)?.label;
	const rate = profile.rate_kg_per_week ?? null;
	return rate === null ? label : `${label}每週 ${formatMacro(rate)} 公斤`;
}

/** 一行摘要（身體資料規格 §6.2），沒設的段落略過；整份都沒設回 `null`。
 *  離線快取裡的舊資料可能少了欄位（`undefined`）：一律 `?? null` 收（handover §7）。 */
function summary(profile: BodyProfile): string | null {
	const birth = profile.birth_year ?? null;
	const height = profile.height_cm ?? null;
	const target = profile.target_weight_kg ?? null;
	const activity = ACTIVITY_OPTIONS.find(
		(option) => option.value === profile.activity_level,
	);
	const parts = [
		SEX_OPTIONS.find((option) => option.value === profile.sex)?.label,
		birth === null ? undefined : `${birth} 年生`,
		height === null ? undefined : `${formatMacro(height)} cm`,
		activity === undefined ? undefined : `${activity.label}活動`,
		goalText(profile),
		target === null ? undefined : `目標 ${formatMacro(target)} 公斤`,
	].filter((part): part is string => part !== undefined);
	return parts.length === 0 ? null : parts.join("・");
}

/** 身體與目標的身體資料（身體資料規格 §6.2；首頁改版從「我的」搬過來）。不算年齡：年齡要「使用者的今天」，前端不算今天。 */
export function BodyProfileCard() {
	const profile = useBodyProfile();

	return (
		<Card testId="body-profile-card">
			<h2 className={`${ui.sectionTitle} ${styles.title}`}>身體資料</h2>
			{profile.isPending ? (
				<p className={styles.text}>載入中…</p>
			) : profile.data == null ? (
				<p className={styles.text}>無法載入身體資料</p>
			) : (
				<p className={styles.text}>{summary(profile.data) ?? "還沒有填"}</p>
			)}
			{/* 看得到的字只有「修改」：卡片標題已經說了改什麼；可及名稱補完整，螢幕閱讀器
			    在連結清單裡才分得出是哪一個「修改」（同每日目標卡片）。 */}
			<Link to="/me/body" aria-label="修改身體資料" className={styles.link}>
				修改
			</Link>
		</Card>
	);
}
