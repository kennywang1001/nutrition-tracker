import type { ReactNode } from "react";
import styles from "./Card.module.css";

type Props = {
	children: ReactNode;
	/** 給測試定位用；卡片本身沒有語意角色。 */
	testId?: string;
};

/** 圓角卡片（規格 §4.1）。只負責外觀，不帶任何語意——需要標題或清單
 *  語意的地方，由呼叫端在裡面放 `<h2>`、`<ul>`。 */
export function Card({ children, testId }: Props) {
	return (
		<div className={styles.card} data-testid={testId}>
			{children}
		</div>
	);
}
